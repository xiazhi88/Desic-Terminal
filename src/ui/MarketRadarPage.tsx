import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Bell,
  Bookmark,
  GitCompareArrows,
  ListFilter,
  CircleAlert,
  Clock3,
  Gauge,
  Loader2,
  RefreshCw,
  Search,
  Save,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Star,
  TrendingUp,
  Volume2,
  Waves,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  MarketAssetsSummary,
  MarketRadarHistoryStatus,
  MarketRadarRankChange,
  MarketRadarResearchScore,
  MarketRadarSavedItem,
  MarketRadarValidationReport,
  Ticker,
} from "../types";
import {
  applyRadarFilter,
  buildMarketBreadth,
  buildMarketRadarRows,
  parseNaturalRadarFilter,
  type MarketBreadthGroup,
  type MarketRadarRow,
  type NaturalRadarFilterResult,
  type RadarFilterDefinition,
} from "../lib/marketRadar";
import {
  deleteMarketRadarAlertRule,
  deleteMarketRadarFilter,
  listenMarketRadarHistory,
  loadMarketRadarAlertRules,
  loadMarketRadarHistoryStatus,
  loadMarketRadarResearchScores,
  loadMarketRadarSavedFilters,
  loadMarketRadarValidationReport,
  recordMarketRadarSnapshot,
  saveMarketRadarAlertRule,
  saveMarketRadarFilter,
  startMarketRadarHistory,
} from "../lib/okx";
import { SymbolIcon } from "./SymbolIcon";
import { WorkspaceFrame } from "./WorkspaceFrame";
import "./MarketRadarPage.css";

type RadarView = "overview" | "strong" | "movers" | "active" | "stable" | "new" | "stocks" | "expert";
type RadarToolMode = "filters" | "alerts" | "compare" | "breadth" | "validation";

const MarketRadarExpertLayer = lazy(() => import("./MarketRadarExpertLayer"));

type Props = Readonly<{
  marketAssets: MarketAssetsSummary | null;
  tickers: Ticker[];
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
  watchlist: string[];
  cacheDir?: string;
  desktop: boolean;
  onNotify: (notification: { kind: "success" | "info" | "warning" | "error"; title: string; message: string }) => void;
  onRefresh: () => void;
  onOpenSymbol: (instId: string) => void;
  onUseForBacktest: (instId: string) => void;
  onAddWatch: (instId: string) => void;
  onRemoveWatch: (instId: string) => void;
}>;

export function MarketRadarPage({
  marketAssets,
  tickers,
  fetchedAt,
  loading,
  error,
  watchlist,
  cacheDir,
  desktop,
  onNotify,
  onRefresh,
  onOpenSymbol,
  onUseForBacktest,
  onAddWatch,
  onRemoveWatch,
}: Props) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.toLowerCase().startsWith("zh");
  const text = (zh: string, en: string) => chinese ? zh : en;
  const [view, setView] = useState<RadarView>("overview");
  const [query, setQuery] = useState("");
  const [researchScores, setResearchScores] = useState<MarketRadarResearchScore[]>([]);
  const rows = useMemo(
    () => buildMarketRadarRows(marketAssets?.instruments ?? [], tickers, researchScores),
    [marketAssets?.instruments, researchScores, tickers]
  );
  const [selectedId, setSelectedId] = useState<string>("");
  const [historyStatus, setHistoryStatus] = useState<MarketRadarHistoryStatus | null>(null);
  const [toolMode, setToolMode] = useState<RadarToolMode | null>(null);
  const [activeFilter, setActiveFilter] = useState<RadarFilterDefinition>({ version: 1 });
  const [naturalFilter, setNaturalFilter] = useState("");
  const [savedFilters, setSavedFilters] = useState<MarketRadarSavedItem[]>([]);
  const [alertRules, setAlertRules] = useState<MarketRadarSavedItem[]>([]);
  const [filterName, setFilterName] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [rankChanges, setRankChanges] = useState<MarketRadarRankChange[]>([]);
  const [validationReport, setValidationReport] = useState<MarketRadarValidationReport | null>(null);
  const [validationLoading, setValidationLoading] = useState(false);
  const recordedSnapshotKey = useRef("");
  const validationRequested = useRef(false);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listenMarketRadarHistory((status) => {
      if (active) setHistoryStatus(status);
    }).then((dispose) => {
      if (!active) dispose?.();
      else unlisten = dispose;
    });
    void loadMarketRadarResearchScores().then((scores) => {
      if (active) setResearchScores(scores);
    });
    void loadMarketRadarHistoryStatus()
      .then((status) => {
        if (active && status) setHistoryStatus(status);
        return startMarketRadarHistory();
      })
      .then((status) => {
        if (active && status) setHistoryStatus(status);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (historyStatus?.phase !== "hourly" && historyStatus?.phase !== "complete") return;
    let active = true;
    void loadMarketRadarResearchScores().then((scores) => {
      if (active) setResearchScores(scores);
    });
    return () => { active = false; };
  }, [historyStatus?.phase]);

  useEffect(() => {
    let active = true;
    void Promise.all([loadMarketRadarSavedFilters(), loadMarketRadarAlertRules()]).then(([filters, rules]) => {
      if (active) {
        setSavedFilters(filters);
        setAlertRules(rules);
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!desktop || !fetchedAt || rows.length === 0) return;
    const bucket = Math.floor(fetchedAt / 3_600_000);
    const key = `${bucket}:${researchScores.length}`;
    if (recordedSnapshotKey.current === key) return;
    recordedSnapshotKey.current = key;
    let active = true;
    const modelVersion = `market-radar-composite-v1:${researchScores[0]?.modelVersion ?? "snapshot-v1"}`;
    void recordMarketRadarSnapshot({
      fetchedAt,
      modelVersion,
      rows: rows.map((row) => ({
        instId: row.instrument.instId,
        category: row.instrument.instCategory,
        listTime: Number(row.instrument.listTime || 0) || undefined,
        rank: row.rank,
        compositeScore: row.compositeScore,
        strengthScore: row.research
          ? row.research.strengthScore * 0.315 + row.strengthScore * 0.12
          : row.strengthScore * 0.40,
        lowVolatilityScore: row.research ? row.research.lowVolatilityScore * 0.14 : 0,
        activityScore: row.research
          ? row.research.activityScore * 0.14 + row.activityScore * 0.105
          : row.activityScore * 0.35,
        rawActivityScore: row.research?.activityScore ?? row.activityScore,
        trendQualityScore: row.research ? row.research.trendQualityScore * 0.105 : 0,
        rawTrendQualityScore: row.research?.trendQualityScore,
        volatility20dPct: row.research?.volatility20dPct,
        liquidityScore: row.liquidityScore * (row.research ? 0.075 : 0.25),
        change24hPct: row.change24hPct,
        turnover24h: row.turnover24h,
        lastPrice: row.last,
        spreadBps: row.spreadBps ?? undefined,
        historyReady: Boolean(row.research),
      })),
    }).then((result) => {
      if (!active || !result) return;
      setRankChanges(result.changes);
      for (const alert of result.alerts) {
        onNotify({
          kind: alert.kind === "spreadAbove" ? "warning" : "info",
          title: alert.ruleName,
          message: radarAlertMessage(alert, chinese),
        });
      }
    });
    return () => { active = false; };
  }, [chinese, desktop, fetchedAt, onNotify, researchScores, rows]);

  useEffect(() => {
    if (toolMode !== "validation" || validationRequested.current) return;
    let active = true;
    validationRequested.current = true;
    setValidationLoading(true);
    void loadMarketRadarValidationReport(90).then((report) => {
      if (active) setValidationReport(report);
    }).finally(() => {
      if (active) setValidationLoading(false);
    });
    return () => { active = false; };
  }, [toolMode]);

  const visibleRows = useMemo(() => {
    const normalizedQuery = query.trim().toUpperCase();
    const filtered = applyRadarFilter(rows, activeFilter, watchlist).filter((row) => !normalizedQuery
      || row.instrument.instId.includes(normalizedQuery)
      || row.instrument.baseCcy.includes(normalizedQuery)
      || row.instrument.instFamily.includes(normalizedQuery)
      || row.instrument.securityName?.toUpperCase().includes(normalizedQuery)
      || row.instrument.securityNameZhHans?.toUpperCase().includes(normalizedQuery)
      || row.instrument.securityNameZhHant?.toUpperCase().includes(normalizedQuery));
    const scoped = view === "stocks" ? filtered.filter((row) => row.instrument.instCategory === "3") : filtered;
    return [...scoped].sort((left, right) => {
      if (view === "strong") return (right.research?.relativeStrength30dPct ?? right.change24hPct) - (left.research?.relativeStrength30dPct ?? left.change24hPct);
      if (view === "movers") return right.amplitude24hPct - left.amplitude24hPct;
      if (view === "active") return right.turnover24h - left.turnover24h;
      if (view === "stable") return (left.research?.volatility20dPct ?? left.amplitude24hPct) - (right.research?.volatility20dPct ?? right.amplitude24hPct)
        || (left.spreadBps ?? Number.POSITIVE_INFINITY) - (right.spreadBps ?? Number.POSITIVE_INFINITY);
      if (view === "new") return Number(right.instrument.listTime || 0) - Number(left.instrument.listTime || 0);
      return right.compositeScore - left.compositeScore;
    });
  }, [activeFilter, query, rows, view, watchlist]);

  useEffect(() => {
    if (!visibleRows.length) {
      setSelectedId("");
      return;
    }
    if (!visibleRows.some((row) => row.instrument.instId === selectedId)) {
      setSelectedId(visibleRows[0].instrument.instId);
    }
  }, [selectedId, visibleRows]);

  const selected = visibleRows.find((row) => row.instrument.instId === selectedId) ?? visibleRows[0] ?? null;
  const rankChangeMap = useMemo(() => new Map(rankChanges.map((change) => [change.instId, change])), [rankChanges]);
  const breadth = useMemo(() => buildMarketBreadth(rows), [rows]);
  const compareRows = compareIds.flatMap((instId) => rows.find((row) => row.instrument.instId === instId) ?? []);
  const parsedNaturalFilter = useMemo(() => parseNaturalRadarFilter(naturalFilter), [naturalFilter]);
  const filterActiveCount = Object.keys(activeFilter).filter((key) => key !== "version" && activeFilter[key as keyof RadarFilterDefinition] != null && activeFilter[key as keyof RadarFilterDefinition] !== false).length;

  const applySavedFilter = (item: MarketRadarSavedItem) => {
    try {
      const definition = JSON.parse(item.definitionJson) as RadarFilterDefinition;
      if (definition.version === 1) setActiveFilter(definition);
    } catch {
      onNotify({ kind: "warning", title: text("筛选方案不可用", "Filter unavailable"), message: text("保存的筛选定义无法解析。", "The saved filter definition could not be parsed.") });
    }
  };
  const saveCurrentFilter = async () => {
    const name = filterName.trim();
    if (!name) return;
    const item = await saveMarketRadarFilter({
      id: `filter-${crypto.randomUUID()}`,
      name,
      definitionJson: JSON.stringify(activeFilter),
      enabled: true,
    });
    if (!item) return;
    setSavedFilters((current) => [item, ...current]);
    setFilterName("");
    onNotify({ kind: "success", title: text("筛选方案已保存", "Filter saved"), message: name });
  };
  const removeSavedFilter = async (id: string) => {
    if (!await deleteMarketRadarFilter(id)) return;
    setSavedFilters((current) => current.filter((item) => item.id !== id));
  };
  const addCompare = (instId: string) => {
    setCompareIds((current) => current.includes(instId) ? current : current.length < 4 ? [...current, instId] : current);
    setToolMode("compare");
  };

  const tabs: Array<{ id: RadarView; label: string; icon: typeof Activity }> = [
    { id: "overview", label: text("综合", "Overview"), icon: Gauge },
    { id: "strong", label: text("强势", "Strength"), icon: TrendingUp },
    { id: "movers", label: text("异动", "Movers"), icon: Waves },
    { id: "active", label: text("活跃", "Activity"), icon: Volume2 },
    { id: "stable", label: text("稳健", "Stable"), icon: Activity },
    { id: "new", label: text("新上线", "New"), icon: Sparkles },
    { id: "stocks", label: text("股票永续", "Stock perps"), icon: BarChart3 },
    { id: "expert", label: text("高级模型", "Advanced models"), icon: SlidersHorizontal },
  ];

  return (
    <WorkspaceFrame tone="market" className="market-radar-page">
      <header className="market-radar-page__header">
        <div className="market-radar-page__identity">
          <span className="market-radar-page__mark"><Gauge size={17} /></span>
          <div>
            <strong>{text("市场雷达", "Market Radar")}</strong>
            <span>{text("全市场相对比较与研究优先级", "Cross-market comparison and research priority")}</span>
          </div>
        </div>
        <div className="market-radar-page__freshness">
          <Clock3 size={13} />
          <span>{fetchedAt ? text(`${formatAge(fetchedAt, true)}更新`, `Updated ${formatAge(fetchedAt, false)}`) : text("等待首次快照", "Waiting for first snapshot")}</span>
          <button type="button" onClick={onRefresh} disabled={loading} title={text("刷新全市场快照", "Refresh market snapshot")} aria-label={text("刷新全市场快照", "Refresh market snapshot")}>
            {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          </button>
        </div>
      </header>

      <div className="market-radar-page__toolbar">
        <nav className="market-radar-page__tabs" aria-label={text("雷达视图", "Radar views")}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={clsx(view === id && "is-active")} onClick={() => setView(id)}>
              <Icon size={13} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {view !== "expert" ? (
          <label className="market-radar-page__search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text("搜索全部交易对", "Search all markets")} />
            {query ? <button type="button" onClick={() => setQuery("")} title={text("清空", "Clear")}><X size={12} /></button> : null}
          </label>
        ) : null}
        {view !== "expert" ? (
          <div className="market-radar-page__tools" aria-label={text("研究工具", "Research tools")}>
            <button type="button" className={clsx(toolMode === "filters" && "is-active")} onClick={() => setToolMode(toolMode === "filters" ? null : "filters")} title={text("筛选方案", "Filters")}>
              <ListFilter size={13} /><span>{text("筛选", "Filter")}</span>{filterActiveCount ? <b>{filterActiveCount}</b> : null}
            </button>
            <button type="button" className={clsx(toolMode === "alerts" && "is-active")} onClick={() => setToolMode(toolMode === "alerts" ? null : "alerts")} title={text("雷达提醒", "Radar alerts")}>
              <Bell size={13} /><span>{text("提醒", "Alerts")}</span>
            </button>
            <button type="button" className={clsx(toolMode === "compare" && "is-active")} onClick={() => setToolMode(toolMode === "compare" ? null : "compare")} title={text("多标的比较", "Compare markets")}>
              <GitCompareArrows size={13} /><span>{text("比较", "Compare")}</span>{compareIds.length ? <b>{compareIds.length}</b> : null}
            </button>
            <button type="button" className={clsx(toolMode === "breadth" && "is-active")} onClick={() => setToolMode(toolMode === "breadth" ? null : "breadth")} title={text("市场宽度", "Market breadth")}>
              <BarChart3 size={13} /><span>{text("宽度", "Breadth")}</span>
            </button>
            <button type="button" className={clsx(toolMode === "validation" && "is-active")} onClick={() => setToolMode(toolMode === "validation" ? null : "validation")} title={text("历史有效性", "Historical validation")}>
              <Bookmark size={13} /><span>{text("验证", "Validate")}</span>
            </button>
          </div>
        ) : null}
      </div>

      <div className={clsx("market-radar-page__history", error && "is-error")} title={error ?? historyStatus?.message}>
        {error ? <CircleAlert size={14} /> : historyStatus?.state === "running" ? <Loader2 className="spin" size={14} /> : <BarChart3 size={14} />}
        <span>{error ?? historyStatusLabel(historyStatus, chinese)}</span>
        {historyStatus?.state === "running" && historyStatus.total > 0 ? (
          <i><em style={{ width: `${Math.min(100, historyStatus.completed / historyStatus.total * 100)}%` }} /></i>
        ) : null}
      </div>

      {toolMode ? (
        <RadarToolsPanel
          mode={toolMode}
          chinese={chinese}
          rows={rows}
          breadth={breadth}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          naturalFilter={naturalFilter}
          onNaturalFilterChange={setNaturalFilter}
          parsedNaturalFilter={parsedNaturalFilter}
          savedFilters={savedFilters}
          alertRules={alertRules}
          selectedId={selected?.instrument.instId}
          filterName={filterName}
          onFilterNameChange={setFilterName}
          onApplySavedFilter={applySavedFilter}
          onSaveFilter={() => void saveCurrentFilter()}
          onDeleteFilter={(id) => void removeSavedFilter(id)}
          onSaveAlert={async (input) => {
            const item = await saveMarketRadarAlertRule(input);
            if (item) setAlertRules((current) => [item, ...current.filter((rule) => rule.id !== item.id)]);
          }}
          onDeleteAlert={async (id) => {
            if (await deleteMarketRadarAlertRule(id)) setAlertRules((current) => current.filter((rule) => rule.id !== id));
          }}
          compareRows={compareRows}
          onAddCompare={addCompare}
          onRemoveCompare={(instId) => setCompareIds((current) => current.filter((id) => id !== instId))}
          rankChanges={rankChanges}
          validationReport={validationReport}
          validationLoading={validationLoading}
          onReloadValidation={() => {
            validationRequested.current = true;
            setValidationLoading(true);
            void loadMarketRadarValidationReport(90).then(setValidationReport).finally(() => setValidationLoading(false));
          }}
        />
      ) : null}

      {view === "expert" ? (
        <div className="market-radar-page__expert-host">
          <Suspense fallback={<div className="market-radar-expert__state"><Loader2 className="spin" size={16} /><span>{text("正在加载高级模型", "Loading advanced models")}</span></div>}>
            <MarketRadarExpertLayer
              chinese={chinese}
              desktop={desktop}
              watchlist={watchlist}
              onNotify={onNotify}
              onUseForBacktest={onUseForBacktest}
              onAddToWatchlist={onAddWatch}
            />
          </Suspense>
        </div>
      ) : (
      <div className="market-radar-page__body">
        <section className="market-radar-table" aria-label={text("市场排行", "Market ranking")}>
          <div className="market-radar-table__head" role="row">
            <span>{text("排名", "Rank")}</span>
            <span>{text("交易对", "Market")}</span>
            <span>{text("综合评分", "Composite score")}</span>
            <span>{text("24h 涨跌", "24h change")}</span>
            <span>{text("24h 成交额", "24h turnover")}</span>
            <span>{text("点差", "Spread")}</span>
            <span aria-hidden="true" />
          </div>
          <div className="market-radar-table__scroll">
            {visibleRows.length ? visibleRows.map((row, index) => {
              const starred = watchlist.includes(row.instrument.instId);
              const rankChange = rankChangeMap.get(row.instrument.instId);
              return (
                <div
                  className={clsx("market-radar-table__row", selected?.instrument.instId === row.instrument.instId && "is-selected")}
                  role="button"
                  tabIndex={0}
                  key={row.instrument.instId}
                  onClick={() => setSelectedId(row.instrument.instId)}
                  onDoubleClick={() => onOpenSymbol(row.instrument.instId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onOpenSymbol(row.instrument.instId);
                  }}
                >
                  <span className="market-radar-table__rank">
                    <b>{view === "overview" ? row.rank : index + 1}</b>
                    {view === "overview" && rankChange?.rankDelta1h ? <small className={rankChange.rankDelta1h > 0 ? "is-up" : "is-down"}>{rankChange.rankDelta1h > 0 ? "↑" : "↓"}{Math.abs(rankChange.rankDelta1h)}</small> : null}
                  </span>
                  <span className="market-radar-table__market">
                    <SymbolIcon base={row.instrument.baseCcy} iconPath={row.instrument.iconPath} cached={row.instrument.iconCached} cacheDir={cacheDir} />
                    <span title={securityIdentityTitle(row.instrument)}>
                      <strong>{row.instrument.baseCcy}</strong>
                      <small>{row.instrument.localizedSecurityName || row.instrument.securityName || row.instrument.instId}</small>
                    </span>
                  </span>
                  <span className="market-radar-table__score"><b>{row.compositeScore.toFixed(0)}</b><i><em style={{ width: `${row.compositeScore}%` }} /></i></span>
                  <span className={clsx("market-radar-table__number", row.change24hPct > 0 ? "is-positive" : row.change24hPct < 0 && "is-negative")}>{signedPercent(row.change24hPct)}</span>
                  <span className="market-radar-table__number">{compactUsd(row.turnover24h)}</span>
                  <span className="market-radar-table__number">{row.spreadBps == null ? "--" : `${row.spreadBps.toFixed(1)} bp`}</span>
                  <button
                    type="button"
                    className={clsx("market-radar-table__star", starred && "is-on")}
                    disabled={!starred && watchlist.length >= 10}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (starred) onRemoveWatch(row.instrument.instId);
                      else onAddWatch(row.instrument.instId);
                    }}
                    title={starred ? text("移出自选", "Remove from watchlist") : text("加入自选", "Add to watchlist")}
                    aria-label={starred ? text("移出自选", "Remove from watchlist") : text("加入自选", "Add to watchlist")}
                  ><Star size={13} /></button>
                </div>
              );
            }) : (
              <div className="market-radar-table__empty">{loading ? text("正在获取全市场快照", "Loading market snapshot") : text("没有符合条件的交易对", "No matching markets")}</div>
            )}
          </div>
        </section>

        <aside className="market-radar-detail" aria-label={text("评分说明", "Score explanation")}>
          {selected ? <RadarDetail
            row={selected}
            rankChange={rankChangeMap.get(selected.instrument.instId)}
            chinese={chinese}
            onOpen={() => onOpenSymbol(selected.instrument.instId)}
            onCompare={() => addCompare(selected.instrument.instId)}
          /> : null}
        </aside>
      </div>
      )}
    </WorkspaceFrame>
  );
}

function RadarToolsPanel({
  mode,
  chinese,
  rows,
  breadth,
  activeFilter,
  onFilterChange,
  naturalFilter,
  onNaturalFilterChange,
  parsedNaturalFilter,
  savedFilters,
  alertRules,
  selectedId,
  filterName,
  onFilterNameChange,
  onApplySavedFilter,
  onSaveFilter,
  onDeleteFilter,
  onSaveAlert,
  onDeleteAlert,
  compareRows,
  onAddCompare,
  onRemoveCompare,
  rankChanges,
  validationReport,
  validationLoading,
  onReloadValidation,
}: {
  mode: RadarToolMode;
  chinese: boolean;
  rows: MarketRadarRow[];
  breadth: MarketBreadthGroup[];
  activeFilter: RadarFilterDefinition;
  onFilterChange: (definition: RadarFilterDefinition) => void;
  naturalFilter: string;
  onNaturalFilterChange: (value: string) => void;
  parsedNaturalFilter: NaturalRadarFilterResult;
  savedFilters: MarketRadarSavedItem[];
  alertRules: MarketRadarSavedItem[];
  selectedId?: string;
  filterName: string;
  onFilterNameChange: (value: string) => void;
  onApplySavedFilter: (item: MarketRadarSavedItem) => void;
  onSaveFilter: () => void;
  onDeleteFilter: (id: string) => void;
  onSaveAlert: (input: { id: string; name: string; definitionJson: string; enabled?: boolean }) => Promise<void>;
  onDeleteAlert: (id: string) => Promise<void>;
  compareRows: MarketRadarRow[];
  onAddCompare: (instId: string) => void;
  onRemoveCompare: (instId: string) => void;
  rankChanges: MarketRadarRankChange[];
  validationReport: MarketRadarValidationReport | null;
  validationLoading: boolean;
  onReloadValidation: () => void;
}) {
  const text = (zh: string, en: string) => chinese ? zh : en;
  const [compareCandidate, setCompareCandidate] = useState("");
  const [alertName, setAlertName] = useState("");
  const [alertKind, setAlertKind] = useState("enterTop");
  const [alertThreshold, setAlertThreshold] = useState("20");
  const [alertScope, setAlertScope] = useState<"all" | "selected">("all");
  const updateNumber = (key: keyof RadarFilterDefinition, raw: string) => {
    const value = raw.trim() === "" ? undefined : Number(raw);
    onFilterChange({ ...activeFilter, [key]: value });
  };

  if (mode === "filters") {
    return (
      <section className="market-radar-tools-panel" aria-label={text("筛选方案", "Filters")}>
        <div className="market-radar-tools-panel__natural">
          <Search size={14} />
          <input value={naturalFilter} onChange={(event) => onNaturalFilterChange(event.target.value)} placeholder={text("例如：股票，成交额至少 500 万，点差小于 5bp，趋势稳定性 70", "Example: stocks, turnover above 5m, spread below 5bp, trend above 70")} />
          <button type="button" disabled={!parsedNaturalFilter.recognized.length} onClick={() => onFilterChange(parsedNaturalFilter.definition)}>{text("应用", "Apply")}</button>
        </div>
        {naturalFilter ? (
          <div className="market-radar-tools-panel__parse">
            {parsedNaturalFilter.recognized.map((condition) => <span key={condition}>{condition}</span>)}
            {parsedNaturalFilter.unsupported.map((condition) => <span className="is-unsupported" key={condition}>{text("未识别：", "Unsupported: ")}{condition}</span>)}
          </div>
        ) : null}
        <div className="market-radar-filter-grid">
          <label><span>{text("产品类别", "Category")}</span><select value={activeFilter.category ?? ""} onChange={(event) => onFilterChange({ ...activeFilter, category: (event.target.value || undefined) as RadarFilterDefinition["category"] })}><option value="">{text("全部", "All")}</option><option value="1">{text("加密货币", "Crypto")}</option><option value="3">{text("股票", "Stock")}</option><option value="4">{text("商品", "Commodity")}</option><option value="5">{text("外汇", "FX")}</option><option value="6">{text("债券", "Bond")}</option></select></label>
          <label><span>{text("最低成交额", "Min turnover")}</span><input type="number" min="0" value={activeFilter.minTurnover24h ?? ""} onChange={(event) => updateNumber("minTurnover24h", event.target.value)} /></label>
          <label><span>{text("最大点差 bp", "Max spread bp")}</span><input type="number" min="0" step="0.1" value={activeFilter.maxSpreadBps ?? ""} onChange={(event) => updateNumber("maxSpreadBps", event.target.value)} /></label>
          <label><span>{text("最低综合评分", "Min composite")}</span><input type="number" min="0" max="100" value={activeFilter.minCompositeScore ?? ""} onChange={(event) => updateNumber("minCompositeScore", event.target.value)} /></label>
          <label><span>{text("最低趋势稳定性", "Min trend stability")}</span><input type="number" min="0" max="100" value={activeFilter.minTrendQualityScore ?? ""} onChange={(event) => updateNumber("minTrendQualityScore", event.target.value)} /></label>
          <label><span>{text("最大 20 日波动率 %", "Max 20d volatility %")}</span><input type="number" min="0" step="0.1" value={activeFilter.maxVolatility20dPct ?? ""} onChange={(event) => updateNumber("maxVolatility20dPct", event.target.value)} /></label>
          <label><span>{text("最近上线天数", "Listed within days")}</span><input type="number" min="0" value={activeFilter.listedWithinDays ?? ""} onChange={(event) => updateNumber("listedWithinDays", event.target.value)} /></label>
          <label className="market-radar-filter-grid__check"><input type="checkbox" checked={Boolean(activeFilter.historyReady)} onChange={(event) => onFilterChange({ ...activeFilter, historyReady: event.target.checked || undefined })} /><span>{text("仅历史就绪", "History ready only")}</span></label>
          <label className="market-radar-filter-grid__check"><input type="checkbox" checked={Boolean(activeFilter.watchlistOnly)} onChange={(event) => onFilterChange({ ...activeFilter, watchlistOnly: event.target.checked || undefined })} /><span>{text("仅自选", "Watchlist only")}</span></label>
        </div>
        <div className="market-radar-saved-filters">
          <div className="market-radar-saved-filters__save">
            <input value={filterName} onChange={(event) => onFilterNameChange(event.target.value)} maxLength={64} placeholder={text("筛选方案名称", "Filter name")} />
            <button type="button" disabled={!filterName.trim()} onClick={onSaveFilter}><Save size={13} />{text("保存", "Save")}</button>
            <button type="button" onClick={() => onFilterChange({ version: 1 })}>{text("重置", "Reset")}</button>
          </div>
          <div className="market-radar-saved-filters__list">
            {savedFilters.map((item) => <span key={item.id}><button type="button" onClick={() => onApplySavedFilter(item)}>{item.name}</button><button type="button" onClick={() => onDeleteFilter(item.id)} title={text("删除", "Delete")}><Trash2 size={12} /></button></span>)}
            {!savedFilters.length ? <small>{text("还没有保存的筛选方案", "No saved filters yet")}</small> : null}
          </div>
        </div>
      </section>
    );
  }

  if (mode === "compare") {
    const available = rows.filter((row) => !compareRows.some((selected) => selected.instrument.instId === row.instrument.instId));
    return (
      <section className="market-radar-tools-panel" aria-label={text("多标的比较", "Market comparison")}>
        <div className="market-radar-compare__add">
          <select value={compareCandidate} onChange={(event) => setCompareCandidate(event.target.value)}><option value="">{text("选择交易对", "Choose market")}</option>{available.slice(0, 200).map((row) => <option key={row.instrument.instId} value={row.instrument.instId}>{row.instrument.baseCcy} · {row.instrument.localizedSecurityName || row.instrument.securityName || row.instrument.instId}</option>)}</select>
          <button type="button" disabled={!compareCandidate || compareRows.length >= 4} onClick={() => { onAddCompare(compareCandidate); setCompareCandidate(""); }}>{text("加入比较", "Add")}</button>
          <span>{text(`已选择 ${compareRows.length}/4`, `${compareRows.length}/4 selected`)}</span>
        </div>
        {compareRows.length ? (
          <div className="market-radar-compare-grid">
            {compareRows.map((row) => <article key={row.instrument.instId}>
              <button type="button" onClick={() => onRemoveCompare(row.instrument.instId)} title={text("移除", "Remove")}><X size={12} /></button>
              <strong>{row.instrument.baseCcy}</strong><small>{row.instrument.localizedSecurityName || row.instrument.securityName || row.instrument.instId}</small>
              <dl><div><dt>{text("综合", "Composite")}</dt><dd>{row.compositeScore.toFixed(0)}</dd></div><div><dt>{text("30 日强度", "30d strength")}</dt><dd>{row.research ? signedPercent(row.research.relativeStrength30dPct) : "--"}</dd></div><div><dt>{text("20 日波动率", "20d volatility")}</dt><dd>{row.research ? `${row.research.volatility20dPct.toFixed(2)}%` : "--"}</dd></div><div><dt>{text("趋势稳定性", "Trend stability")}</dt><dd>{row.research?.trendQualityScore.toFixed(0) ?? "--"}</dd></div><div><dt>{text("24h 成交额", "24h turnover")}</dt><dd>{compactUsd(row.turnover24h)}</dd></div><div><dt>{text("点差", "Spread")}</dt><dd>{row.spreadBps == null ? "--" : `${row.spreadBps.toFixed(1)} bp`}</dd></div></dl>
            </article>)}
          </div>
        ) : <div className="market-radar-tools-panel__empty">{text("从排行详情中加入 2 至 4 个标的进行比较。", "Add 2 to 4 markets from ranking details.")}</div>}
      </section>
    );
  }

  if (mode === "breadth") {
    return (
      <section className="market-radar-tools-panel" aria-label={text("市场宽度", "Market breadth")}>
        <div className="market-radar-breadth-grid">
          {breadth.map((group) => <article key={group.category}><strong>{breadthCategoryLabel(group.category, chinese)}{group.strengthRank ? <b>#{group.strengthRank}</b> : null}</strong><small>{group.count} {text("个合约", "markets")}</small><dl><div><dt>{text("上涨占比", "Advancing")}</dt><dd>{group.advancePct.toFixed(0)}%</dd></div><div><dt>{text("30 日正趋势", "Positive 30d")}</dt><dd>{group.positiveTrendPct.toFixed(0)}%</dd></div><div><dt>{text("历史覆盖", "History coverage")}</dt><dd>{group.historyCoveragePct.toFixed(0)}%</dd></div><div><dt>{text("中位涨跌", "Median change")}</dt><dd className={group.medianChange24hPct >= 0 ? "is-positive" : "is-negative"}>{signedPercent(group.medianChange24hPct)}</dd></div><div><dt>{text("中位评分", "Median score")}</dt><dd>{group.medianCompositeScore.toFixed(0)}</dd></div></dl></article>)}
        </div>
      </section>
    );
  }

  if (mode === "alerts") {
    const requiresThreshold = alertKind !== "historyReady";
    const saveAlert = async () => {
      const threshold = requiresThreshold ? Number(alertThreshold) : undefined;
      if (!alertName.trim() || (requiresThreshold && (!Number.isFinite(threshold) || threshold! < 0))) return;
      await onSaveAlert({
        id: `alert-${crypto.randomUUID()}`,
        name: alertName.trim(),
        definitionJson: JSON.stringify({
          version: 1,
          kind: alertKind,
          threshold,
          cooldownMinutes: 360,
          dailyLimit: 5,
          instIds: alertScope === "selected" && selectedId ? [selectedId] : [],
        }),
        enabled: true,
      });
      setAlertName("");
    };
    return (
      <section className="market-radar-tools-panel" aria-label={text("雷达提醒", "Radar alerts")}>
        <div className="market-radar-alert-form">
          <input value={alertName} onChange={(event) => setAlertName(event.target.value)} maxLength={64} placeholder={text("提醒名称", "Alert name")} />
          <select value={alertKind} onChange={(event) => setAlertKind(event.target.value)}>
            <option value="enterTop">{text("首次进入 Top N", "Enters Top N")}</option>
            <option value="rankRise">{text("1 小时排名上升", "1h rank rise")}</option>
            <option value="activityAbove">{text("活跃度跨过阈值", "Activity crosses threshold")}</option>
            <option value="spreadAbove">{text("点差恶化超过 bp", "Spread worsens above bp")}</option>
            <option value="newListing">{text("新标的首次出现", "New listing appears")}</option>
            <option value="historyReady">{text("研究历史首次就绪", "Research history becomes ready")}</option>
          </select>
          {requiresThreshold ? <input type="number" min="0" value={alertThreshold} onChange={(event) => setAlertThreshold(event.target.value)} aria-label={text("阈值", "Threshold")} /> : <span className="market-radar-alert-form__fixed">{text("状态变化", "State transition")}</span>}
          <select value={alertScope} onChange={(event) => setAlertScope(event.target.value as "all" | "selected")}><option value="all">{text("全市场", "All markets")}</option><option value="selected" disabled={!selectedId}>{text("当前选中标的", "Selected market")}</option></select>
          <button type="button" disabled={!alertName.trim()} onClick={() => void saveAlert()}><Bell size={13} />{text("创建", "Create")}</button>
        </div>
        <div className="market-radar-alert-list">
          {alertRules.map((rule) => {
            const definition = safeJsonObject(rule.definitionJson);
            return <span key={rule.id}>
              <input type="checkbox" checked={rule.enabled} onChange={(event) => void onSaveAlert({ id: rule.id, name: rule.name, definitionJson: rule.definitionJson, enabled: event.target.checked })} aria-label={text(`启用 ${rule.name}`, `Enable ${rule.name}`)} />
              <strong>{rule.name}</strong><small>{alertRuleLabel(definition, chinese)}</small>
              <button type="button" onClick={() => void onDeleteAlert(rule.id)} title={text("删除", "Delete")}><Trash2 size={12} /></button>
            </span>;
          })}
          {!alertRules.length ? <div className="market-radar-tools-panel__empty">{text("还没有提醒规则。所有提醒每 6 小时冷却、每规则每天最多 5 条，全局每天最多 20 条。", "No alert rules yet. Alerts cool down for 6 hours, with 5 per rule and 20 globally per day.")}</div> : null}
        </div>
        <p className="market-radar-alert-notice">{text("提醒只报告研究状态变化，不是买卖信号，也不会触发订单。", "Alerts report research-state changes only. They are not trade signals and never place orders.")}</p>
      </section>
    );
  }

  const withDayHistory = rankChanges.filter((change) => change.rank24h != null).length;
  const withWeekHistory = rankChanges.filter((change) => change.rank7d != null).length;
  return (
    <section className="market-radar-tools-panel" aria-label={text("历史有效性", "Historical validation")}>
      <div className="market-radar-validation-head">
        <div><strong>{validationReport?.status === "ready" ? text("点时历史有效性", "Point-in-time validation") : text("点时验证数据正在积累", "Point-in-time validation is accumulating")}</strong><span>{validationReport ? text(`${validationReport.snapshotDates} 个真实快照日 · 最近 ${validationReport.lookbackDays} 天`, `${validationReport.snapshotDates} real snapshot dates · last ${validationReport.lookbackDays} days`) : text(`1 日排名可比较 ${withDayHistory} · 7 日可比较 ${withWeekHistory}`, `${withDayHistory} comparable at 1d · ${withWeekHistory} at 7d`)}</span></div>
        <button type="button" onClick={onReloadValidation} disabled={validationLoading} title={text("重新计算", "Recalculate")}>{validationLoading ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}</button>
      </div>
      {validationReport ? (
        <>
          <div className="market-radar-validation-grid">
            {validationReport.horizons.map((horizon) => <article key={horizon.horizonDays}>
              <strong>{horizon.horizonDays}{text(" 日前向", "d forward")}</strong><small>{horizon.dates} {text("个日期", "dates")} · {horizon.observations} {text("个观察", "observations")}</small>
              <dl>
                <div><dt>Rank IC</dt><dd>{metricNumber(horizon.rankIc, 3)}</dd></div>
                <div><dt>{text("训练段 IC", "Training IC")}</dt><dd>{metricNumber(horizon.trainingRankIc, 3)}</dd></div>
                <div><dt>{text("验证段 IC", "Validation IC")}</dt><dd>{metricNumber(horizon.validationRankIc, 3)}</dd></div>
                <div><dt>{text("IC 稳定差", "IC stability delta")}</dt><dd>{metricNumber(horizon.icStabilityDelta, 3)}</dd></div>
                <div><dt>Top 10%</dt><dd>{metricPercent(horizon.topQuantileReturnPct)}</dd></div>
                <div><dt>Bottom 10%</dt><dd>{metricPercent(horizon.bottomQuantileReturnPct)}</dd></div>
                <div><dt>{text("毛收益差", "Gross spread")}</dt><dd>{metricPercent(horizon.grossSpreadPct)}</dd></div>
                <div><dt>{text("点差后净收益差", "Net after spread")}</dt><dd>{metricPercent(horizon.netSpreadAfterCostPct)}</dd></div>
                <div><dt>{text("Top 胜率", "Top win rate")}</dt><dd>{metricPercent(horizon.topQuantileWinRatePct)}</dd></div>
                <div><dt>{text("Top 换手率", "Top turnover")}</dt><dd>{metricPercent(horizon.topQuantileTurnoverPct)}</dd></div>
              </dl>
            </article>)}
          </div>
          {validationReport.regimes.length ? <div className="market-radar-validation-regimes"><strong>{text("5 日市场状态", "5d market regimes")}</strong>{validationReport.regimes.map((regime) => <span key={regime.regime}><i>{regimeLabel(regime.regime, chinese)}</i><b>IC {metricNumber(regime.rankIc, 3)}</b><small>{text("收益差", "Spread")} {metricPercent(regime.grossSpreadPct)} · {regime.dates} {text("日", "dates")}</small></span>)}</div> : null}
          <div className="market-radar-validation-model">{text("模型版本", "Model versions")}: {validationReport.modelVersions.join(" · ") || "--"}</div>
        </>
      ) : <div className="market-radar-validation-readiness"><small>{text("历史有效性只使用保存后的真实产品宇宙，不会用当前存活合约倒填过去。", "Validation uses saved point-in-time universes only and never backfills the past with today's surviving markets.")}</small></div>}
    </section>
  );
}

function RadarAttribution({ delta, chinese }: { delta: NonNullable<MarketRadarRankChange["componentDelta24h"]>; chinese: boolean }) {
  const text = (zh: string, en: string) => chinese ? zh : en;
  const values = [
    [text("综合评分", "Composite"), delta.composite],
    [text("强度", "Strength"), delta.strength],
    [text("低波动", "Low volatility"), delta.lowVolatility],
    [text("成交活跃", "Activity"), delta.activity],
    [text("趋势稳定性", "Trend stability"), delta.trendQuality],
    [text("流动性", "Liquidity"), delta.liquidity],
  ] as Array<[string, number]>;
  return <div className="market-radar-attribution"><strong>{text("1 日评分变化归因", "1d score change attribution")}</strong>{values.map(([label, value]) => <span key={label}><i>{label}</i><b className={value >= 0 ? "is-positive" : "is-negative"}>{value > 0 ? "+" : ""}{value.toFixed(1)}</b></span>)}</div>;
}

function RadarDetail({
  row,
  rankChange,
  chinese,
  onOpen,
  onCompare,
}: {
  row: MarketRadarRow;
  rankChange?: MarketRadarRankChange;
  chinese: boolean;
  onOpen: () => void;
  onCompare: () => void;
}) {
  const text = (zh: string, en: string) => chinese ? zh : en;
  const listTime = Number(row.instrument.listTime || 0);
  return (
    <>
      <div className="market-radar-detail__title">
        <div>
          <strong>{row.instrument.baseCcy}</strong>
          <span>{row.instrument.localizedSecurityName || row.instrument.securityName || row.instrument.instId}</span>
          {row.instrument.localizedSecurityName && row.instrument.securityName ? <small>{row.instrument.securityName}</small> : null}
          {row.instrument.securityName ? <small>{row.instrument.instId}</small> : null}
        </div>
        <div className="market-radar-detail__actions">
          <button type="button" onClick={onCompare} title={text("加入比较", "Add to comparison")}><GitCompareArrows size={14} />{text("比较", "Compare")}</button>
          <button type="button" onClick={onOpen}><ArrowUpRight size={14} />{text("图表", "Chart")}</button>
        </div>
      </div>
      <div className="market-radar-detail__price">
        <strong>{formatPrice(row.last)}</strong>
        <span className={clsx(row.change24hPct >= 0 ? "is-positive" : "is-negative")}>{signedPercent(row.change24hPct)}</span>
      </div>
      <div className="market-radar-detail__scores">
        {row.research ? (
          <>
            <ScoreLine label={text("30 天相对强度", "30d relative strength")} value={row.research.strengthScore} detail={text(`过去 30 天收益 ${signedPercent(row.research.relativeStrength30dPct)}，并与全市场比较`, `30d return ${signedPercent(row.research.relativeStrength30dPct)}, ranked across the market`)} />
            <ScoreLine label={text("低波动", "Low volatility")} value={row.research.lowVolatilityScore} detail={text(`20 天日收益波动率 ${row.research.volatility20dPct.toFixed(2)}%`, `20d daily-return volatility ${row.research.volatility20dPct.toFixed(2)}%`)} />
            <ScoreLine label={text("成交活跃变化", "Volume activity change")} value={row.research.activityScore} detail={row.research.volumeRatio20d == null ? text("历史成交额不足", "Insufficient turnover history") : text(`最近日成交额为 20 日均值的 ${row.research.volumeRatio20d.toFixed(2)} 倍`, `Latest daily turnover is ${row.research.volumeRatio20d.toFixed(2)}x its 20d average`)} />
            <ScoreLine label={text("趋势稳定性", "Trend stability")} value={row.research.trendQualityScore} detail={text(`30 天对数价格趋势拟合度 ${row.research.trendQuality30d.toFixed(0)}%`, `30d log-price trend fit ${row.research.trendQuality30d.toFixed(0)}%`)} />
          </>
        ) : (
          <>
            <ScoreLine label={text("市场强度", "Market strength")} value={row.strengthScore} detail={text("与全部可评分合约的 24 小时涨跌比较", "24h change versus all scored markets")} />
            <ScoreLine label={text("成交活跃", "Trading activity")} value={row.activityScore} detail={text("按估算 USDT 成交额进行全市场比较", "Estimated USDT turnover versus the market")} />
            <ScoreLine label={text("报价流动性", "Quote liquidity")} value={row.liquidityScore} detail={text("买一卖一点差越低，评分越高", "Tighter bid-ask spreads score higher")} />
          </>
        )}
      </div>
      <dl className="market-radar-detail__facts">
        <div><dt>{text("1 小时排名变化", "1h rank change")}</dt><dd>{rankDeltaLabel(rankChange?.rankDelta1h, chinese)}</dd></div>
        <div><dt>{text("1 日排名变化", "1d rank change")}</dt><dd>{rankDeltaLabel(rankChange?.rankDelta24h, chinese)}</dd></div>
        <div><dt>{text("7 日排名变化", "7d rank change")}</dt><dd>{rankDeltaLabel(rankChange?.rankDelta7d, chinese)}</dd></div>
        <div><dt>{text("评分来源", "Score source")}</dt><dd>{row.research ? text("日线模型 70% + 快照 30%", "Daily model 70% + snapshot 30%") : text("当前市场快照", "Current market snapshot")}</dd></div>
        <div><dt>{text("24h 振幅", "24h range")}</dt><dd>{row.amplitude24hPct.toFixed(2)}%</dd></div>
        <div><dt>{text("24h 成交额", "24h turnover")}</dt><dd>{compactUsd(row.turnover24h)}</dd></div>
        <div><dt>{text("产品类别", "Asset category")}</dt><dd>{categoryLabel(row.instrument.instCategory, chinese)}</dd></div>
        {row.instrument.securityName ? <div><dt>{text("标的名称", "Security name")}</dt><dd title={row.instrument.localizedSecurityName || row.instrument.securityName}>{row.instrument.localizedSecurityName || row.instrument.securityName}</dd></div> : null}
        {row.instrument.localizedSecurityName && row.instrument.securityName ? <div><dt>{text("官方英文名称", "Official English name")}</dt><dd title={row.instrument.securityName}>{row.instrument.securityName}</dd></div> : null}
        {row.instrument.listingExchange ? <div><dt>{text("上市交易所", "Listing exchange")}</dt><dd>{row.instrument.listingExchange}</dd></div> : null}
        {row.instrument.securityLocalizationSource ? <div><dt>{text("中文名称来源", "Localized name source")}</dt><dd>{row.instrument.securityLocalizationSource}</dd></div> : null}
        {row.instrument.securityMetadataSource ? <div><dt>{text("英文名称来源", "English name source")}</dt><dd>{row.instrument.securityMetadataSource}</dd></div> : null}
        {row.research ? <div><dt>{text("日线数据截止", "Daily data as of")}</dt><dd>{new Date(row.research.asOf).toLocaleDateString()}</dd></div> : null}
        {listTime > 0 ? <div><dt>{text("上线时间", "Listed")}</dt><dd>{new Date(listTime).toLocaleDateString()}</dd></div> : null}
      </dl>
      {rankChange?.componentDelta24h ? <RadarAttribution delta={rankChange.componentDelta24h} chinese={chinese} /> : null}
      <p className="market-radar-detail__notice">{text("该评分只用于市场研究优先级，不是交易建议或自动交易命令。", "This score prioritizes research only. It is not trading advice or an automatic order.")}</p>
    </>
  );
}

function ScoreLine({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="market-radar-score-line" title={detail}>
      <span><strong>{label}</strong><b>{value.toFixed(0)}</b></span>
      <i><em style={{ width: `${value}%` }} /></i>
      <small>{detail}</small>
    </div>
  );
}

function metricNumber(value: number | null | undefined, digits = 2) {
  return value == null || !Number.isFinite(value) ? "--" : value.toFixed(digits);
}

function metricPercent(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function regimeLabel(regime: string, chinese: boolean) {
  const labels: Record<string, [string, string]> = {
    up: ["上涨", "Up"],
    sideways: ["震荡", "Sideways"],
    down: ["下跌", "Down"],
  };
  return (labels[regime] ?? [regime, regime])[chinese ? 0 : 1];
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function alertRuleLabel(definition: Record<string, unknown>, chinese: boolean) {
  const kind = String(definition.kind || "");
  const threshold = Number(definition.threshold);
  const labels: Record<string, [string, string]> = {
    enterTop: [`进入 Top ${threshold}`, `Enters Top ${threshold}`],
    rankRise: [`1 小时上升 ${threshold} 名`, `Rises ${threshold} ranks in 1h`],
    activityAbove: [`活跃度跨过 ${threshold}`, `Activity crosses ${threshold}`],
    spreadAbove: [`点差跨过 ${threshold} bp`, `Spread crosses ${threshold} bp`],
    newListing: [`最近 ${threshold} 天新标的`, `New listing within ${threshold}d`],
    historyReady: ["研究历史首次就绪", "Research history becomes ready"],
  };
  return (labels[kind] ?? [kind, kind])[chinese ? 0 : 1];
}

function radarAlertMessage(alert: { kind: string; instId: string; currentValue: number; threshold: number }, chinese: boolean) {
  const labels: Record<string, [string, string]> = {
    enterTop: [`${alert.instId} 首次进入 Top ${alert.threshold}`, `${alert.instId} entered Top ${alert.threshold}`],
    rankRise: [`${alert.instId} 一小时上升 ${alert.currentValue.toFixed(0)} 名`, `${alert.instId} rose ${alert.currentValue.toFixed(0)} ranks in one hour`],
    activityAbove: [`${alert.instId} 活跃度升至 ${alert.currentValue.toFixed(0)}`, `${alert.instId} activity rose to ${alert.currentValue.toFixed(0)}`],
    spreadAbove: [`${alert.instId} 点差扩大至 ${alert.currentValue.toFixed(1)} bp`, `${alert.instId} spread widened to ${alert.currentValue.toFixed(1)} bp`],
    newListing: [`发现新标的 ${alert.instId}`, `New market detected: ${alert.instId}`],
    historyReady: [`${alert.instId} 研究历史已就绪`, `${alert.instId} research history is ready`],
  };
  return (labels[alert.kind] ?? [alert.instId, alert.instId])[chinese ? 0 : 1];
}

function rankDeltaLabel(value: number | null | undefined, chinese: boolean) {
  if (value == null) return chinese ? "等待快照" : "Awaiting snapshot";
  if (value === 0) return chinese ? "持平" : "Unchanged";
  return value > 0 ? `↑ ${value}` : `↓ ${Math.abs(value)}`;
}

function breadthCategoryLabel(category: string, chinese: boolean) {
  if (category === "all") return chinese ? "全市场" : "All markets";
  return categoryLabel(category, chinese);
}

function historyStatusLabel(status: MarketRadarHistoryStatus | null, chinese: boolean) {
  if (!status || status.state === "idle") return chinese ? "低频研究历史将在后台准备，不影响当前快照排行" : "Low-frequency research history will prepare in the background";
  if (status.state === "running") {
    const phase = status.phase === "daily" ? (chinese ? "日线" : "daily") : status.phase === "hourly" ? (chinese ? "小时线" : "hourly") : (chinese ? "准备" : "preparing");
    return chinese
      ? `正在准备${phase}研究历史 ${status.completed}/${status.total}${status.currentSymbol ? ` · ${status.currentSymbol}` : ""}`
      : `Preparing ${phase} research history ${status.completed}/${status.total}${status.currentSymbol ? ` · ${status.currentSymbol}` : ""}`;
  }
  if (status.state === "completed") return chinese ? `研究历史就绪：日线 ${status.dailyReady} · 小时线 ${status.hourlyReady}` : `Research history ready: ${status.dailyReady} daily · ${status.hourlyReady} hourly`;
  return chinese ? `研究历史部分可用：日线 ${status.dailyReady} · 小时线 ${status.hourlyReady} · ${status.failed} 个序列不可用` : `Research history partial: ${status.dailyReady} daily · ${status.hourlyReady} hourly · ${status.failed} unavailable`;
}

function categoryLabel(category: string | undefined, chinese: boolean) {
  const labels: Record<string, [string, string]> = {
    "1": ["加密货币", "Crypto"],
    "3": ["股票类资产", "Stock"],
    "4": ["大宗商品", "Commodity"],
    "5": ["外汇", "FX"],
    "6": ["债券", "Bond"],
  };
  const pair = labels[category ?? ""];
  return pair ? pair[chinese ? 0 : 1] : (chinese ? "其他" : "Other");
}

function formatAge(time: number, chinese: boolean) {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000));
  if (seconds < 60) return chinese ? `${seconds} 秒前` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return chinese ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return chinese ? `${hours} 小时前` : `${hours}h ago`;
}

function securityIdentityTitle(instrument: MarketAssetsSummary["instruments"][number]) {
  return [...new Set([
    instrument.localizedSecurityName,
    instrument.securityName,
    instrument.instId,
  ].filter(Boolean))].join("\n");
}

function signedPercent(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function compactUsd(value: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatPrice(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 1_000 ? 2 : value >= 1 ? 4 : 8 }).format(value);
}
