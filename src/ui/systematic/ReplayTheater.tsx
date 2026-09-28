/*
 * ReplayTheater.tsx — 「回放剧场」：结果与回放页的多轨时间线。
 * 移植自 viz/prototypes/replay-theater.html：KPI 条、HUD、五条同步轨道、走带控制、
 * 交易卡与单行交易回合列表。画布与播放由 ReplayTheaterEngine 负责（播放头不进入 React state），
 * 本组件只负责 DOM 骨架、KPI / 交易卡 / 列表，以及按视图与播放头懒加载回放分页。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  loadSystematicBacktestDetail,
  type SystematicBacktestDetail,
  type SystematicBacktestFill,
  type SystematicBacktestStatistics,
  type SystematicBacktestView,
  type SystematicClosedTrade,
  type SystematicEquityPoint,
  type SystematicReplaySnapshot,
  type SystematicStrategyActionEvent,
} from "../../lib/systematic";
import {
  CoverageSet,
  THEATER_PAGE_BARS,
  TheaterBarStore,
  buildEquitySeries,
  buildEvents,
  buildTimeline,
  estimateCalmar,
  groupActions,
  groupRounds,
  maxAbsNet,
  mergeActions,
  mergeEquityPoints,
  mergeSnapshots,
  pageOfEvalBar,
  roundActions,
  uOfT,
  type TheaterRound,
  type TheaterTimeline,
} from "./replayTheaterModel";
import {
  MINUS,
  NF0,
  NF2,
  ReplayTheaterEngine,
  f2,
  fT,
  pad,
  pct,
  pnlCls,
  priceFmt,
  qtyFmt,
  s2,
  theaterCopy,
  type TheaterCopy,
  type TheaterData,
} from "./replayTheaterRender";
import "./replay-theater.css";

type Props = {
  run: SystematicBacktestView;
  detail: SystematicBacktestDetail;
  chinese: boolean;
};

type Filter = "all" | "win" | "loss";
/** 每秒推进的 1m 根数：4 / 16 / 64 适合逐笔看，256 起用于快速浏览长回测（4K 根/秒 ≈ 每秒 2.8 天）。 */
const SPEEDS = [4, 16, 64, 256, 1024, 4096] as const;
/** 播放时预取播放头之后约这么多秒会用到的页，保证高速播放时价格与保证金轨不断档。 */
const PLAYBACK_PREFETCH_SECONDS = 3;
/** View-driven page loading stops beyond this many pages in view (the playhead page always loads). */
const MAX_VIEW_PAGES = 16;
const PAGE_RETRY_MS = 8_000;

function uiCopy(chinese: boolean) {
  const zh = chinese;
  return {
    netPnl: zh ? "净盈亏" : "Net PnL",
    gross: zh ? "毛" : "Gross",
    fees: zh ? "费用" : "Fees",
    totalReturn: zh ? "总收益" : "Total return",
    finalEquity: zh ? "期末权益" : "Final equity",
    maxDrawdown: zh ? "最大回撤" : "Max drawdown",
    winRate: zh ? "胜率" : "Win rate",
    winsLosses: (w: string, l: string) => (zh ? `${w} 胜 / ${l} 负（按平仓记录）` : `${w}W / ${l}L (by close)`),
    trades: zh ? "交易" : "Trades",
    closesUnit: zh ? "笔平仓" : "closes",
    roundsPartials: (r: string, p: string) => (zh ? `${r} 个持仓回合 · ${p} 次分批` : `${r} rounds · ${p} partials`),
    profitFactor: zh ? "盈亏因子" : "Profit factor",
    expectancy: zh ? "单笔期望" : "Expectancy",
    calmar: "Calmar",
    inferred: zh ? "推算" : "Est.",
    calmarTitle: zh ? "报告未提供，按 年化收益(单利) ÷ 最大回撤 在前端推算" : "Not in the report; estimated in the app as simple annualized return ÷ max drawdown",
    calmarSub: (ann: string, days: string) => (zh ? `年化 ${ann} ÷ 回撤 · ${days} 天` : `Ann. ${ann} ÷ DD · ${days} d`),
    sharpe: zh ? "夏普" : "Sharpe",
    exposure: zh ? "持仓暴露" : "Exposure",
    avgHolding: zh ? "平均持有" : "Avg. hold",
    summary: zh ? "回放概要" : "Replay summary",
    fullRun: zh ? "完整回测" : "Full run",
    hint: zh ? "点击交易带、价格标记或列表行查看单笔明细；" : "Click the ribbon, a price marker or a row for trade details; ",
    hintKeys: zh ? "切换回合，" : "switch rounds, ",
    hintPlay: zh ? "播放。" : "play.",
    space: zh ? "空格" : "Space",
    sharpeAnn: zh ? "夏普 (1m 年化)" : "Sharpe (1m ann.)",
    sortinoAnn: zh ? "索提诺 (1m 年化)" : "Sortino (1m ann.)",
    volAnn: zh ? "波动率 (年化)" : "Volatility (ann.)",
    avgWinLoss: zh ? "平均盈 / 亏" : "Avg win / loss",
    payoff: zh ? "盈亏比" : "Payoff ratio",
    largest: zh ? "最大盈 / 亏" : "Largest win / loss",
    streak: zh ? "最长连胜 / 连亏" : "Max win / loss streak",
    feesFunding: zh ? "费用 / 资金费用" : "Fees / funding",
    oneClose: zh ? "一次平仓" : "Single exit",
    multiClose: (n: number) => (zh ? `${n} 次平仓 · 含分批` : `${n} exits · incl. partial`),
    closeCard: zh ? "取消选择 (Esc)" : "Clear selection (Esc)",
    netUnit: zh ? "USDT 净盈亏" : "USDT net PnL",
    marginReturn: zh ? "保证金收益" : "Return on margin",
    entry: zh ? "开仓" : "Entry",
    exit: zh ? "平仓" : "Exit",
    avg: zh ? "均价" : "Avg",
    quantity: zh ? "数量" : "Qty",
    holding: zh ? "持有" : "Held",
    grossPnl: zh ? "毛盈亏" : "Gross",
    fee: zh ? "手续费" : "Fees",
    margin: zh ? "保证金" : "Margin",
    funding: zh ? "资金费" : "Funding",
    fillsN: (n: number) => (zh ? `成交 ${n}` : `Fills ${n}`),
    fillsInferred: zh ? "按时间关联（报告无成交 ID）" : "linked by time (no fill IDs in report)",
    actionsN: (n: number) => (zh ? `策略动作 ${n}` : `Strategy actions ${n}`),
    actionsLoading: zh ? "该回合所在区间的动作正在加载…" : "Loading actions for this round…",
    noActions: zh ? "该回合无策略动作（仅引擎成交）" : "No strategy actions in this round (engine fills only)",
    since: zh ? " 起" : " onward",
    replayThis: zh ? "回放此笔" : "Replay trade",
    jumpEntry: zh ? "播放头到开仓" : "Playhead to entry",
    prevRound: zh ? "上一笔 ([)" : "Previous ([)",
    nextRound: zh ? "下一笔 (])" : "Next (])",
    rounds: zh ? "交易回合" : "Rounds",
    closeRecords: (n: string) => (zh ? `${n} 条平仓记录` : `${n} close records`),
    filter: zh ? "筛选" : "Filter",
    all: zh ? "全部" : "All",
    win: zh ? "盈利" : "Wins",
    loss: zh ? "亏损" : "Losses",
    colSide: zh ? "向" : "Side",
    colEntry: zh ? "开仓" : "Entry",
    colHold: zh ? "持有" : "Held",
    colNet: zh ? "净盈亏" : "Net",
    colExit: zh ? "平仓" : "Exit",
    partialTag: zh ? "分" : "p",
    partialTitle: (n: number) => (zh ? `分批平仓 ${n} 次` : `${n} partial exits`),
    emptyList: zh ? "没有符合条件的回合" : "No matching rounds",
    prevAct: zh ? "上一个动作 (⇧←)" : "Previous action (⇧←)",
    prevBar: zh ? "上一根 K 线 (←)" : "Previous bar (←)",
    nextBar: zh ? "下一根 K 线 (→)" : "Next bar (→)",
    nextAct: zh ? "下一个动作 (⇧→)" : "Next action (⇧→)",
    speed: zh ? "回放速度（每秒推进根数）" : "Replay speed (bars per second)",
    barsPerSec: zh ? " 根/秒" : " bars/s",
    navTitle: zh ? "拖动窗口平移 · 拖动边缘缩放 · 在空白处拖出新区间" : "Drag window to pan · drag edges to zoom · drag elsewhere for a new range",
    showing: zh ? "显示" : "Showing",
    barsUnit: zh ? "根" : "bars",
    fit: zh ? "全部" : "All",
    fitTitle: zh ? "显示全部 (0)" : "Show all (0)",
    loadingPage: zh ? "正在加载回放区间" : "Loading replay range",
    pageFailed: zh ? "回放区间加载失败，稍后自动重试" : "Replay range failed to load; retrying shortly",
    long: zh ? "多" : "L",
    short: zh ? "空" : "S",
    longTag: zh ? "▲ 多" : "▲ Long",
    shortTag: zh ? "▼ 空" : "▼ Short",
    contracts: zh ? " 张" : " ct",
    buy: zh ? "买入" : "Buy",
    sell: zh ? "卖出" : "Sell",
  };
}
type UiCopy = ReturnType<typeof uiCopy>;

type Store = {
  tl: TheaterTimeline;
  bars: TheaterBarStore;
  cover: CoverageSet;
  equity: Map<number, SystematicEquityPoint>;
  snapshots: readonly SystematicReplaySnapshot[];
  actions: readonly SystematicStrategyActionEvent[];
  closedTrades: readonly SystematicClosedTrade[];
  fills: readonly SystematicBacktestFill[];
  hasSnapshotRecords: boolean;
  lastPageLoaded: boolean;
};

function createStore(detail: SystematicBacktestDetail): Store {
  const tl = buildTimeline(detail);
  const store: Store = {
    tl,
    bars: new TheaterBarStore(tl),
    cover: new CoverageSet(),
    equity: new Map(),
    snapshots: [],
    actions: [],
    closedTrades: [],
    fills: [],
    hasSnapshotRecords: false,
    lastPageLoaded: false,
  };
  mergePage(store, detail);
  return store;
}

function mergePage(store: Store, detail: SystematicBacktestDetail) {
  const report = detail.report;
  store.bars.addPage(detail.bars);
  if (!report) return;
  const pre = store.tl.preloadBars;
  if (detail.bars.length) store.cover.add(pre + detail.barOffset, pre + detail.barOffset + detail.bars.length);
  const snapshots = report.replaySnapshots ?? [];
  if (snapshots.length) store.hasSnapshotRecords = true;
  store.snapshots = mergeSnapshots(store.snapshots, snapshots);
  store.actions = mergeActions(store.actions, report.strategyActions ?? []);
  mergeEquityPoints(store.equity, report.equityCurve ?? []);
  if (report.closedTrades.length >= store.closedTrades.length) store.closedTrades = report.closedTrades;
  if (report.fills.length >= store.fills.length) store.fills = report.fills;
  if (detail.barOffset + detail.bars.length >= detail.totalBarCount) store.lastPageLoaded = true;
}

function toTheaterData(store: Store, detail: SystematicBacktestDetail, instId: string): TheaterData {
  const report = detail.report!;
  const initial = report.metrics.initialEquityUsdt;
  const rounds = groupRounds(store.closedTrades, store.fills, store.tl);
  return {
    tl: store.tl,
    bars: store.bars,
    rounds,
    maxAbsNet: maxAbsNet(rounds),
    equity: buildEquitySeries(store.equity, initial, store.tl),
    initialEquity: initial,
    snapshots: store.snapshots,
    cover: store.cover,
    actions: store.actions,
    events: buildEvents(store.actions, store.fills, store.closedTrades, store.tl),
    equityArchived: Boolean(report.equitySeriesArchived),
    hasSnapshotRecords: store.hasSnapshotRecords,
    instId,
  };
}

const fmtRatio = (x?: number | null, d = 2) => (x === undefined || x === null || !Number.isFinite(x) ? "—" : x.toFixed(d));

export function ReplayTheater({ run, detail, chinese }: Props) {
  const t = useMemo(() => uiCopy(chinese), [chinese]);
  const tc = useMemo(() => theaterCopy(chinese), [chinese]);
  const storeRef = useRef<Store | null>(null);
  if (!storeRef.current) storeRef.current = createStore(detail);
  const [data, setData] = useState<TheaterData>(() => toTheaterData(storeRef.current!, detail, run.instId));
  const [selKey, setSelKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [speed, setSpeed] = useState<number>(16);
  const [pageStatus, setPageStatus] = useState<"idle" | "loading" | "error">("idle");
  const engineRef = useRef<ReplayTheaterEngine | null>(null);
  const failedRef = useRef(new Map<number, number>());
  const inflightRef = useRef(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const tracksRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const floatsRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLCanvasElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const clockDRef = useRef<HTMLDivElement | null>(null);
  const clockSRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<HTMLSpanElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  const report = detail.report!;
  const metrics = report.metrics;
  const statistics = report.statistics ?? null;

  // ── 引擎生命周期 ──
  useLayoutEffect(() => {
    const host = {
      root: rootRef.current!, tracks: tracksRef.current!, canvas: canvasRef.current!, labels: labelsRef.current!,
      floats: floatsRef.current!, tip: tipRef.current!, nav: navRef.current!, hud: hudRef.current!,
      clockD: clockDRef.current!, clockS: clockSRef.current!, zoomN: zoomRef.current!, play: playRef.current!, list: listRef.current!,
    };
    const engine = new ReplayTheaterEngine(host, data, tc, {
      onSelect: (round) => setSelKey(round?.key ?? null),
      onPlayingChange: () => undefined,
    });
    engineRef.current = engine;
    engine.bindRows();
    return () => { engine.destroy(); engineRef.current = null; };
    // The engine is created once per mounted run; later data arrives through setData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { engineRef.current?.setCopy(tc); }, [tc]);
  useEffect(() => { engineRef.current?.setData(data); }, [data]);

  // ── 分页懒加载：播放头所在页 → 选中回合 → 视图内（由中心向外） ──
  const loadPage = useCallback(async (page: number) => {
    const store = storeRef.current!;
    inflightRef.current = true;
    setPageStatus("loading");
    try {
      const offset = page * THEATER_PAGE_BARS;
      const next = await loadSystematicBacktestDetail({ runId: run.id, offset, limit: THEATER_PAGE_BARS });
      if (!next || !next.report || storeRef.current !== store) return;
      mergePage(store, next);
      failedRef.current.delete(page);
      setData(toTheaterData(store, detail, run.instId));
      setPageStatus("idle");
    } catch {
      failedRef.current.set(page, Date.now());
      setPageStatus("error");
    } finally {
      inflightRef.current = false;
    }
  }, [detail, run.id, run.instId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const engine = engineRef.current;
      const store = storeRef.current;
      if (!engine || !store || inflightRef.current) return;
      const { tl, cover } = store;
      const ev = tl.evalBars;
      if (ev <= 0) return;
      const lastPage = pageOfEvalBar(ev - 1);
      const pageRange = (p: number) => [tl.preloadBars + p * THEATER_PAGE_BARS, tl.preloadBars + Math.min(ev, (p + 1) * THEATER_PAGE_BARS)] as const;
      const isLoaded = (p: number) => { const [a, b] = pageRange(p); return cover.covers(a, b); };
      const now = Date.now();
      const usable = (p: number) => p >= 0 && p <= lastPage && !isLoaded(p) && now - (failedRef.current.get(p) ?? 0) > PAGE_RETRY_MS;
      const needs = engine.needs();
      const wanted: number[] = [];
      if (!store.lastPageLoaded) wanted.push(lastPage);
      const playPage = pageOfEvalBar(needs.playhead);
      wanted.push(playPage);
      if (needs.playing) {
        const ahead = Math.max(THEATER_PAGE_BARS * 0.3, needs.speed * PLAYBACK_PREFETCH_SECONDS);
        const lastAhead = pageOfEvalBar(Math.min(ev - 1, needs.playhead + ahead));
        for (let p = playPage + 1; p <= lastAhead; p++) wanted.push(p);
      }
      if (needs.selected) {
        for (let p = pageOfEvalBar(needs.selected[0]); p <= pageOfEvalBar(Math.max(needs.selected[0], needs.selected[1] - 1)); p++) wanted.push(p);
      }
      const v0 = pageOfEvalBar(needs.viewStart);
      const v1 = pageOfEvalBar(Math.max(needs.viewStart, needs.viewEnd - 1));
      if (v1 - v0 + 1 <= MAX_VIEW_PAGES) {
        const centre = (v0 + v1) / 2;
        const inView: number[] = [];
        for (let p = v0; p <= v1; p++) inView.push(p);
        inView.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
        wanted.push(...inView);
      }
      const next = wanted.find(usable);
      if (next !== undefined) void loadPage(next);
    }, 250);
    return () => window.clearInterval(timer);
  }, [loadPage]);

  // ── 选中回合（引擎为唯一来源；React 只渲染卡片） ──
  const selected = useMemo(() => (selKey ? data.rounds.find((round) => round.key === selKey) ?? null : null), [data.rounds, selKey]);

  // ── 列表 ──
  const rows = useMemo(
    () => data.rounds.filter((g) => filter === "all" || (filter === "win" ? g.net > 0 : g.net <= 0)),
    [data.rounds, filter],
  );
  useLayoutEffect(() => { engineRef.current?.bindRows(); }, [rows]);
  // The trade card changes height with the selection, so reveal the row after it renders.
  useLayoutEffect(() => {
    if (selected) engineRef.current?.revealRow(selected.id);
  }, [selected]);

  // ── 交易卡遮罩：内容溢出时底部渐隐 ──
  const syncCardMask = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;
    el.classList.toggle("is-overflow", el.scrollHeight > el.clientHeight + 2);
    el.classList.toggle("is-end", el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
  }, []);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    el.scrollTop = 0;
    const raf = requestAnimationFrame(syncCardMask);
    const ro = new ResizeObserver(syncCardMask);
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [selKey, syncCardMask]);

  const engine = () => engineRef.current;

  // ── KPI ──
  const kpi = useMemo(() => {
    const ret = metrics.initialEquityUsdt > 0 ? metrics.netPnlUsdt / metrics.initialEquityUsdt : 0;
    const calmar = estimateCalmar(metrics.netPnlUsdt, metrics.initialEquityUsdt, metrics.maxDrawdownPct, data.tl);
    const wins = data.rounds.reduce((acc, g) => acc + g.closes.filter((c) => c.netPnlUsdt > 0).length, 0);
    const closes = data.rounds.reduce((acc, g) => acc + g.closes.length, 0);
    const partials = data.rounds.reduce((acc, g) => acc + g.partials, 0);
    const eq = data.equity;
    const ddTime = eq.minIdx >= 0 && eq.dd[eq.minIdx]! < 0 ? eq.timeMs[eq.minIdx]! : null;
    return { ret, calmar, wins, losses: closes - wins, partials, ddTime };
  }, [data.equity, data.rounds, data.tl, metrics]);

  const winRate = metrics.winRate ?? null;

  return (
    <div className="rt" ref={rootRef}>
      <div className="rt-kpis">
        <div className="rt-kpi">
          <div className="rt-kpi__lb">{t.netPnl}</div>
          <div className="rt-kpi__v"><span className={clsx("rt-display", pnlCls(metrics.netPnlUsdt))}>{s2(metrics.netPnlUsdt)}</span><span className="rt-kpi__u">USDT</span></div>
          <div className="rt-kpi__s">{t.gross} <span className="rt-num">{s2(metrics.grossPnlUsdt)}</span> · {t.fees} <span className="rt-num">{MINUS}{NF2.format(Math.abs(metrics.feesUsdt))}</span></div>
        </div>
        <div className="rt-kpi">
          <div className="rt-kpi__lb">{t.totalReturn}</div>
          <div className="rt-kpi__v"><span className={clsx("rt-display", pnlCls(kpi.ret))}>{pct(kpi.ret)}</span></div>
          <div className="rt-kpi__s">{t.finalEquity} <span className="rt-num">{f2(metrics.finalEquityUsdt)}</span></div>
        </div>
        <div className="rt-kpi">
          <div className="rt-kpi__lb">{t.maxDrawdown}</div>
          <div className="rt-kpi__v"><span className={clsx("rt-display", metrics.maxDrawdownPct > 0 && "is-neg")}>{metrics.maxDrawdownPct > 0 ? MINUS : ""}{metrics.maxDrawdownPct.toFixed(2)}%</span></div>
          <div className="rt-kpi__s"><span className="rt-num">{MINUS}{NF2.format(Math.abs(metrics.maxDrawdownUsdt))}</span>{kpi.ddTime ? <> · <span className="rt-num">{fT(kpi.ddTime)}</span></> : null}</div>
        </div>
        <div className="rt-kpi">
          <div className="rt-kpi__lb">{t.winRate}</div>
          <div className="rt-kpi__v"><span className="rt-display">{winRate === null ? "—" : `${(winRate * 100).toFixed(1)}%`}</span></div>
          <div className="rt-kpi__s">{t.winsLosses(NF0.format(kpi.wins), NF0.format(kpi.losses))}</div>
        </div>
        <div className="rt-kpi">
          <div className="rt-kpi__lb">{t.trades}</div>
          <div className="rt-kpi__v"><span className="rt-display">{NF0.format(metrics.closedTradeCount)}</span><span className="rt-kpi__u">{t.closesUnit}</span></div>
          <div className="rt-kpi__s">{t.roundsPartials(NF0.format(data.rounds.length), NF0.format(kpi.partials))}</div>
        </div>
        <div className="rt-kpi">
          <div className="rt-kpi__lb">{t.profitFactor}</div>
          <div className="rt-kpi__v"><span className="rt-display">{fmtRatio(statistics?.profitFactor)}</span></div>
          <div className="rt-kpi__s">{t.expectancy} <span className="rt-num">{statistics?.expectancyUsdt == null ? "—" : s2(statistics.expectancyUsdt)}</span></div>
        </div>
        <div className="rt-kpi">
          <div className="rt-kpi__lb">{t.calmar} <span className="rt-kpi__der" title={t.calmarTitle}>{t.inferred}</span></div>
          <div className="rt-kpi__v"><span className="rt-display">{kpi.calmar?.calmar == null ? "—" : kpi.calmar.calmar.toFixed(1)}</span></div>
          <div className="rt-kpi__s">{kpi.calmar ? t.calmarSub(pct(kpi.calmar.annualReturn, 0), kpi.calmar.days.toFixed(kpi.calmar.days < 10 ? 1 : 0)) : "—"}</div>
        </div>
        <div className="rt-kpi is-minor">
          <span>{t.sharpe}</span><b>{fmtRatio(statistics?.annualizedSharpe)}</b>
          <span>{t.exposure}</span><b>{statistics ? `${statistics.exposurePct.toFixed(1)}%` : "—"}</b>
          <span>{t.avgHolding}</span><b>{statistics?.averageHoldingMs == null ? "—" : tc.duration(statistics.averageHoldingMs)}</b>
        </div>
      </div>

      <div className="rt-stage">
        <section className="rt-theater">
          <div className="rt-hud" ref={hudRef} aria-live="off" />
          <div className="rt-tracks" ref={tracksRef}>
            <canvas ref={canvasRef} tabIndex={0} aria-label={tc.tracks} />
            <div ref={labelsRef} />
            <div className="rt-floats" ref={floatsRef} />
            <div className="rt-tip" ref={tipRef} />
            {pageStatus !== "idle" ? (
              <div className={clsx("rt-page-status", pageStatus === "error" && "is-error")} role="status">{pageStatus === "loading" ? t.loadingPage : t.pageFailed}</div>
            ) : null}
          </div>
          <footer className="rt-transport">
            <div className="rt-ctrls">
              <button type="button" className="rt-ib" title={t.prevAct} aria-label={t.prevAct} onClick={() => engine()?.jumpAct(-1)}><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="3" width="1.6" height="10" rx=".8" /><path d="M13 3.6v8.8a.6.6 0 01-.94.5L5.6 8.5a.6.6 0 010-1l6.46-4.4a.6.6 0 01.94.5z" /></svg></button>
              <button type="button" className="rt-ib" title={t.prevBar} aria-label={t.prevBar} onClick={() => engine()?.stepBar(-1)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5" /></svg></button>
              <button type="button" className="rt-play" ref={playRef} onClick={() => engine()?.togglePlay()} />
              <button type="button" className="rt-ib" title={t.nextBar} aria-label={t.nextBar} onClick={() => engine()?.stepBar(1)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg></button>
              <button type="button" className="rt-ib" title={t.nextAct} aria-label={t.nextAct} onClick={() => engine()?.jumpAct(1)}><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="12.4" y="3" width="1.6" height="10" rx=".8" /><path d="M3 3.6v8.8a.6.6 0 00.94.5l6.46-4.4a.6.6 0 000-1L3.94 3.1a.6.6 0 00-.94.5z" /></svg></button>
            </div>
            <div className="rt-clock"><div className="rt-clock__d rt-num" ref={clockDRef} /><div className="rt-clock__s rt-num" ref={clockSRef} /></div>
            <div className="rt-seg" role="group" aria-label={t.speed}>
              {SPEEDS.map((value, k) => (
                <button key={value} type="button" aria-pressed={speed === value} onClick={() => { setSpeed(value); engine()?.setSpeed(value); }}>
                  {k === 0 ? `${value}${t.barsPerSec}` : value >= 1024 ? `${value / 1024}K` : value}
                </button>
              ))}
            </div>
            <div className="rt-nav" title={t.navTitle}><canvas ref={navRef} /></div>
            <div className="rt-zoomr"><span>{t.showing} <span className="rt-num" ref={zoomRef} /> {t.barsUnit}</span><button type="button" className="rt-btn" title={t.fitTitle} onClick={() => engine()?.fitAll()}>{t.fit}</button></div>
          </footer>
        </section>

        <aside className="rt-side">
          <section className="rt-card" ref={cardRef} aria-live="polite" onScroll={syncCardMask}>
            {selected ? (
              <TradeCard round={selected} t={t} tc={tc} data={data} onClose={() => engine()?.select(null)}
                onReplay={() => engine()?.replayRound(selected)} onJump={() => engine()?.jumpToRound(selected)}
                onPrev={() => engine()?.stepRound(-1)} onNext={() => engine()?.stepRound(1)}
                onSeek={(u) => engine()?.seekTo(u)} />
            ) : (
              <SummaryCard t={t} tc={tc} statistics={statistics} feesUsdt={metrics.feesUsdt} fundingUsdt={metrics.fundingCashflowUsdt} />
            )}
          </section>
          <div className="rt-list-h">
            <b>{t.rounds}</b><span className="rt-list-h__c rt-num">{NF0.format(data.rounds.length)} · {t.closeRecords(NF0.format(data.rounds.reduce((acc, g) => acc + g.closes.length, 0)))}</span>
            <span className="rt-spacer" />
            <div className="rt-seg is-small" role="group" aria-label={t.filter}>
              {(["all", "win", "loss"] as const).map((value) => (
                <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t[value]}</button>
              ))}
            </div>
          </div>
          <div className="rt-cols"><span>#</span><span>{t.colSide}</span><span>{t.colEntry}</span><span className="rt-cols__hold">{t.colHold}</span><span className="is-r">{t.colNet}<small> USDT</small></span><span className="is-r">{t.colExit}</span></div>
          <div className="rt-list" ref={listRef} role="listbox" aria-label={t.rounds}>
            {rows.length ? rows.map((g) => {
              const w = Math.max(4, Math.round(100 * Math.sqrt(Math.abs(g.net) / data.maxAbsNet)));
              return (
                <div
                  key={g.key}
                  className="rt-row"
                  role="option"
                  aria-selected={false}
                  data-round={g.id}
                  title={`${g.side === "short" ? t.short : t.long} ${qtyFmt(g.qty0)}${t.contracts} · ${fT(g.entryTimeMs)} → ${fT(g.exitTimeMs)} · ${g.closes.map((c) => tc.reason(c.exitReason)).join(" / ")}`}
                  onMouseEnter={() => engine()?.setHoverById(g.id)}
                  onMouseLeave={() => engine()?.setHoverById(null)}
                  onClick={() => { const e = engine(); if (e) e.select(e.sel?.id === g.id ? null : g, true); }}
                >
                  <span className="rt-row__n">{pad(g.id)}{g.partials ? <i title={t.partialTitle(g.partials)}>{t.partialTag}</i> : null}</span>
                  <span>{g.side === "short" ? t.short : t.long}</span>
                  <span className="rt-row__t">{fT(g.entryTimeMs)}</span>
                  <span className="rt-row__hold">{tc.duration(g.exitTimeMs - g.entryTimeMs)}</span>
                  <span className="rt-row__pn"><i className={g.net >= 0 ? "is-pos-bg" : "is-neg-bg"} style={{ width: `${w}%` }} /><span className={pnlCls(g.net)}>{s2(g.net)}</span></span>
                  <span className="rt-row__ex">{tc.reasonShort(g.lastReason)}</span>
                </div>
              );
            }) : <div className="rt-empty">{t.emptyList}</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SummaryCard({ t, tc, statistics, feesUsdt, fundingUsdt }: Readonly<{
  t: UiCopy;
  tc: TheaterCopy;
  statistics: SystematicBacktestStatistics | null;
  feesUsdt: number;
  fundingUsdt: number;
}>) {
  const st = statistics ?? null;
  const signed = (x?: number | null) => (x === undefined || x === null ? "—" : s2(x));
  return (
    <>
      <div className="rt-card__h"><b className="rt-card__title">{t.summary}</b><span className="rt-spacer" /><span className="rt-micro">{t.fullRun}</span></div>
      <p className="rt-hint">{t.hint}<kbd>[</kbd><kbd>]</kbd> {t.hintKeys}<kbd>{t.space}</kbd> {t.hintPlay}</p>
      <dl className="rt-sumgrid">
        <dt>{t.sharpeAnn}</dt><dd>{fmtRatio(st?.annualizedSharpe)}</dd>
        <dt>{t.sortinoAnn}</dt><dd>{fmtRatio(st?.annualizedSortino)}</dd>
        <dt>{t.volAnn}</dt><dd>{st?.annualizedVolatilityPct == null ? "—" : `${st.annualizedVolatilityPct.toFixed(1)}%`}</dd>
        <dt>{t.expectancy}</dt><dd className={pnlCls(st?.expectancyUsdt ?? 0)}>{signed(st?.expectancyUsdt)}</dd>
        <dt>{t.avgWinLoss}</dt><dd><span className="is-pos">{signed(st?.averageWinUsdt)}</span> / <span className="is-neg">{signed(st?.averageLossUsdt)}</span></dd>
        <dt>{t.payoff}</dt><dd>{fmtRatio(st?.payoffRatio)}</dd>
        <dt>{t.largest}</dt><dd><span className="is-pos">{signed(st?.largestWinUsdt)}</span> / <span className="is-neg">{signed(st?.largestLossUsdt)}</span></dd>
        <dt>{t.streak}</dt><dd>{st ? `${st.maxConsecutiveWins} / ${st.maxConsecutiveLosses}` : "—"}</dd>
        <dt>{t.avgHolding}</dt><dd>{st?.averageHoldingMs == null ? "—" : tc.duration(st.averageHoldingMs)}</dd>
        <dt>{t.exposure}</dt><dd>{st ? `${st.exposurePct.toFixed(1)}%` : "—"}</dd>
        <dt>{t.feesFunding}</dt><dd>{f2(feesUsdt)} / {f2(fundingUsdt)}</dd>
      </dl>
    </>
  );
}

function TradeCard({ round: g, t, tc, data, onClose, onReplay, onJump, onPrev, onNext, onSeek }: Readonly<{
  round: TheaterRound;
  t: UiCopy;
  tc: TheaterCopy;
  data: TheaterData;
  onClose: () => void;
  onReplay: () => void;
  onJump: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (u: number) => void;
}>) {
  const actions = roundActions(g, data.actions);
  const groups = groupActions(actions);
  const actionsCovered = data.cover.covers(Math.max(data.tl.preloadBars, Math.floor(g.u0) - 1), Math.min(data.tl.totalBars, Math.ceil(g.u1)));
  const reasons = [...new Set(g.closes.map((c) => tc.reason(c.exitReason)))].join(" · ");
  return (
    <>
      <div className="rt-card__h">
        <span className="rt-card__id">#{pad(g.id)}</span>
        <span className="rt-dir">{g.side === "short" ? t.shortTag : t.longTag}</span>
        <span className="rt-micro is-tight">{g.closes.length > 1 ? t.multiClose(g.closes.length) : t.oneClose}</span>
        <span className="rt-spacer" />
        <button type="button" className="rt-ib is-small" title={t.closeCard} aria-label={t.closeCard} onClick={onClose}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
      </div>
      <div className="rt-card__big">
        <span className={clsx("rt-display", pnlCls(g.net))}>{s2(g.net)}</span><span className="rt-card__u">{t.netUnit}</span>
        <span className="rt-card__rm rt-num">{t.marginReturn} {g.margin > 0 ? pct(g.net / g.margin, 1) : "—"}</span>
      </div>
      <dl className="rt-kv">
        <dt>{t.entry}</dt><dd>{fT(g.entryTimeMs)}</dd><dt>{t.avg}</dt><dd>{priceFmt(g.entryPrice)}</dd>
        <dt>{t.exit}</dt><dd>{fT(g.exitTimeMs)}</dd><dt>{t.avg}</dt><dd>{priceFmt(g.exitAvg)}</dd>
        <dt>{t.quantity}</dt><dd>{qtyFmt(g.qty0)}{t.contracts}</dd><dt>{t.holding}</dt><dd>{tc.duration(g.exitTimeMs - g.entryTimeMs)}</dd>
        <dt>{t.grossPnl}</dt><dd className={pnlCls(g.gross)}>{s2(g.gross)}</dd><dt>{t.fee}</dt><dd>{MINUS}{NF2.format(Math.abs(g.fees))}</dd>
        <dt>{t.margin}</dt><dd>{f2(g.margin)}</dd><dt>{t.funding}</dt><dd>{f2(g.funding)}</dd>
      </dl>
      <div className="rt-sub-h"><span className="rt-micro" title={t.fillsInferred}>{t.fillsN(g.fills.length)}</span><span className="rt-micro is-plain">{reasons}</span></div>
      <div className="rt-fl">
        {g.fills.map((f, k) => (
          <FillRow key={`${f.timeMs}-${k}`} fill={f} t={t} tc={tc} />
        ))}
      </div>
      <div className="rt-sub-h"><span className="rt-micro">{t.actionsN(actions.length)}</span></div>
      <div className="rt-acts">
        {groups.length ? groups.map((ga, k) => {
          const multi = ga.items.length > 1;
          const reason = multi ? `${ga.first.action.reason ?? ""} → … → ${ga.lastA.action.reason ?? ""}` : ga.first.action.reason ?? "";
          return (
            <div key={`${ga.first.asOfMs}-${k}`} className="rt-act" role="button" tabIndex={0}
              onClick={() => onSeek(uOfT(data.tl, ga.first.asOfMs))}
              onKeyDown={(event) => { if (event.key === "Enter") onSeek(uOfT(data.tl, ga.first.asOfMs)); }}>
              <span className="rt-act__n">{k + 1}</span>
              <div>
                <div className="rt-act__h"><b>{tc.kind(ga.first.action)}{multi ? ` ×${ga.items.length}` : ""}</b>{fT(ga.first.asOfMs)}{multi ? t.since : ""}</div>
                <span data-i18n-skip>{reason}</span>
              </div>
            </div>
          );
        }) : <span className="rt-hint">{actionsCovered ? t.noActions : t.actionsLoading}</span>}
      </div>
      <div className="rt-card__actions">
        <button type="button" className="rt-btn" onClick={onReplay}>{t.replayThis}</button>
        <button type="button" className="rt-btn" onClick={onJump}>{t.jumpEntry}</button>
        <span className="rt-spacer" />
        <button type="button" className="rt-btn is-ghost" title={t.prevRound} aria-label={t.prevRound} onClick={onPrev}>‹</button>
        <button type="button" className="rt-btn is-ghost" title={t.nextRound} aria-label={t.nextRound} onClick={onNext}>›</button>
      </div>
    </>
  );
}

function FillRow({ fill, t, tc }: Readonly<{ fill: SystematicBacktestFill; t: UiCopy; tc: TheaterCopy }>) {
  return (
    <>
      <span className="rt-fl__t">{fT(fill.timeMs)}</span>
      <span>{fill.side === "buy" ? t.buy : t.sell}</span>
      <span className="is-r">{qtyFmt(fill.quantity)}{t.contracts.trim()}</span>
      <span className="is-r">{priceFmt(fill.fillPrice)}</span>
      <span className="rt-fl__why is-r">{tc.reason(fill.reason)}</span>
    </>
  );
}
