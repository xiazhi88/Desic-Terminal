/*
 * 值守心电图 —— AI 自动化「运行记录」的时间轴视图。
 *
 * 每个 Profile 一条泳道，每次运行一个脉冲：宽 = startedAt→finishedAt；矮刻度 = 试判跳过；
 * AI 紫梯形 = 深度分析（高 ∝ √深度 token）；外框 = 强制升级；虚线 = 抽样复检；
 * 下凹警示三角 = 失败；只有运行中的脉冲发光。点击脉冲打开右侧抽屉，抽屉按需读取
 * `ai_automation_run_detail`；「打开完整运行详情」交回现有运行详情弹层。
 */
import clsx from "clsx";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AiAutomationPulseRange, AiAutomationPulseTokens } from "../../lib/ai";
import type { AiAutomationRun, AiAutomationRunDetail } from "../../types";
import { AiMarkdown, normalizeRunMarkdown } from "../AiMarkdown";
import { AXIS_H, WatchPulseEngine, type LaneGeom, type PulseHover, type PulseViewState, type PulseWindow } from "./watchPulseEngine";
import {
  ACTION_KEYS,
  DAY,
  HOUR,
  actionLabel,
  cadenceLabel,
  deepMaxOf,
  deepState,
  fCount,
  fDur,
  fHM,
  fHMS,
  fMD,
  fPct,
  fStamp,
  fTok,
  isDeep,
  isFailedRun,
  laneWake,
  pulseRunFromAutomationRun,
  pulseText,
  sameDay,
  statusLabel,
  summarize,
  triageModeLabel,
  triggerLabel,
  type ActionKey,
  type PulseRun,
  type WatchPulseProfile
} from "./watchPulseModel";
import "./watch-pulse.css";

type DetailState = { detail?: AiAutomationRunDetail; loading?: boolean; error?: string };

export type WatchPulseProps = {
  profiles: WatchPulseProfile[];
  /** 面板实时维护的最新运行（事件驱动），叠加在区间数据之上保证状态最新。 */
  liveRuns?: AiAutomationRun[];
  loadRange: (fromMs: number, toMs: number) => Promise<AiAutomationPulseRange | null>;
  readDetail: (id: string) => Promise<AiAutomationRunDetail | null>;
  onOpenFullDetail: (run: PulseRun) => void;
  /** 预览夹具用固定锚点时钟；默认 Date.now。 */
  now?: () => number;
  toolbarStart?: ReactNode;
  /** 完整运行详情弹层打开时暂停键盘快捷键，避免 Esc 同时关掉抽屉。 */
  suspendKeys?: boolean;
};

const RANGE_REFRESH_MS = 60_000;

function GlyphSvg({ kind, size = 8 }: { kind: ActionKey; size?: number }) {
  if (kind === "trade") return <svg width={size} height={size} viewBox="0 0 8 8" aria-hidden="true"><path d="M4 .6L7.6 7H.4z" fill="var(--wp-ink)" /></svg>;
  if (kind === "opportunity") return <svg width={size} height={size} viewBox="0 0 8 8" aria-hidden="true"><path d="M4 .4L7.6 4 4 7.6.4 4z" fill="var(--wp-ink-2)" /></svg>;
  if (kind === "notification") return <svg width={size} height={size} viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="2.7" fill="var(--wp-ink-3)" /></svg>;
  return <svg width={size} height={size} viewBox="0 0 8 8" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="5" fill="none" stroke="var(--wp-ink-3)" /></svg>;
}

function LiveDot() {
  return <span className="wp-live" aria-hidden="true" />;
}

function StatusTag({ run }: { run: PulseRun }) {
  return (
    <span className={clsx("wp-st", `is-${isFailedRun(run) ? "failed" : run.status}`)}>
      {run.status === "running" ? <LiveDot /> : <i />}
      {statusLabel(run.status)}
    </span>
  );
}

function TriageTags({ run }: { run: PulseRun }) {
  const t = run.triage;
  if (!t) return <span className="wp-tag">{pulseText("pulseTriageOffTag", "Triage off", "未启用试判")}</span>;
  return (
    <>
      {t.verdict ? (
        <span className={clsx("wp-tag", t.verdict === "escalate" && "is-deep")}>
          {t.verdict === "skip" ? pulseText("pulseTriageSkipTag", "Triage: skip", "试判：建议跳过") : pulseText("pulseTriageEscalateTag", "Triage: escalate", "试判：升级")}
        </span>
      ) : (
        <span className="wp-tag">{pulseText("pulseTriageIncomplete", "Triage incomplete", "试判未完成")}</span>
      )}
      {t.forcedBy.length ? (
        <span className="wp-tag is-forced" title={t.forcedBy.join("、")}>
          {pulseText("pulseForcedTag", "Forced:", "强制升级：")}<span className="wp-num" data-i18n-skip>{t.forcedBy.join("、")}</span>
        </span>
      ) : null}
      {t.sampled ? <span className="wp-tag is-deep">{pulseText("pulseSampledTag", "Sampled re-check", "抽样复检")}</span> : null}
    </>
  );
}

function tokLine(u: AiAutomationPulseTokens | null | undefined, pending = false) {
  if (!u) return <em>{pending ? pulseText("pulseTokensPending", "pending", "待结算") : "--"}</em>;
  return <>{fTok(u.totalTokens)} <em>{pulseText("pulseCacheShort", "cache", "缓存")} {fTok(u.cacheReadTokens)}</em></>;
}

function ActionsInline({ run }: { run: PulseRun }) {
  const parts = ACTION_KEYS.filter((key) => run.actionCounts[key]);
  if (!parts.length) return <em>{pulseText("pulseNone", "none", "无")}</em>;
  return (
    <>
      {parts.map((key, i) => (
        <span key={key} className="wp-act-inline">
          {i > 0 ? "  " : null}
          <GlyphSvg kind={key} /> {actionLabel(key)} <span className="wp-num">{run.actionCounts[key]}</span>
        </span>
      ))}
    </>
  );
}

export function WatchPulse({ profiles, liveRuns, loadRange, readDetail, onOpenFullDetail, now: nowProp, toolbarStart, suspendKeys = false }: WatchPulseProps) {
  const nowRef = useRef<() => number>(nowProp ?? Date.now);
  nowRef.current = nowProp ?? Date.now;
  const now = useCallback(() => nowRef.current(), []);

  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const ovBoxRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WatchPulseEngine | null>(null);

  const [rangeRuns, setRangeRuns] = useState<PulseRun[]>([]);
  const [dataStart, setDataStart] = useState(() => now() - 7 * DAY);
  const [rangeState, setRangeState] = useState<{ loading: boolean; error: string | null; truncated: boolean; loaded: boolean }>({ loading: true, error: null, truncated: false, loaded: false });
  const [view, setView] = useState<PulseViewState | null>(null);
  const [lanes, setLanes] = useState<LaneGeom[]>([]);
  const [plotSize, setPlotSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<PulseHover | null>(null);
  const [laneHover, setLaneHover] = useState(-1);
  const [selected, setSelected] = useState<PulseRun | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [, setTick] = useState(0);

  // ── 数据：7 天区间 + 面板实时运行叠加 ──
  const requestRef = useRef(0);
  const refreshRange = useCallback(async () => {
    const request = ++requestRef.current;
    const n = now();
    const start = n - 7 * DAY;
    setRangeState((current) => ({ ...current, loading: true }));
    try {
      const range = await loadRange(start - HOUR, n + HOUR);
      if (request !== requestRef.current) return;
      setDataStart(start);
      setRangeRuns(range?.runs ?? []);
      setRangeState({ loading: false, error: null, truncated: Boolean(range?.truncated), loaded: true });
    } catch (error) {
      if (request !== requestRef.current) return;
      setRangeState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error), loaded: true }));
    }
  }, [loadRange, now]);

  useEffect(() => {
    void refreshRange();
    const timer = window.setInterval(() => void refreshRange(), RANGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshRange]);

  const liveSignature = useMemo(() => (liveRuns ?? []).map((run) => `${run.id}:${run.status}:${run.finishedAt ?? ""}:${run.tokenUsage?.usage?.totalTokens ?? ""}`).join("|"), [liveRuns]);
  // 父组件每次渲染都可能传入新数组；只在内容签名变化时重算，避免每秒重画静态层。
  const liveRunsRef = useRef(liveRuns);
  liveRunsRef.current = liveRuns;
  const firstSignature = useRef(true);
  useEffect(() => {
    if (firstSignature.current) { firstSignature.current = false; return; }
    const timer = window.setTimeout(() => void refreshRange(), 800);
    return () => window.clearTimeout(timer);
  }, [liveSignature, refreshRange]);

  const profileKey = profiles.map((profile) => profile.id).join("|");
  const profileIds = useMemo(() => new Set(profileKey.split("|").filter(Boolean)), [profileKey]);
  const runs = useMemo(() => {
    const byId = new Map<string, PulseRun>();
    for (const run of rangeRuns) if (profileIds.has(run.profileId)) byId.set(run.id, run);
    for (const run of liveRunsRef.current ?? []) {
      if (!profileIds.has(run.profileId) || run.startedAt < dataStart - HOUR) continue;
      const previous = byId.get(run.id);
      const next = pulseRunFromAutomationRun(run);
      // 列表摘要可能缺少分阶段 token；缺什么就保留区间数据里的值。
      byId.set(run.id, previous ? { ...previous, ...next, triage: next.triage ?? previous.triage, tokenUsage: next.tokenUsage ?? previous.tokenUsage } : next);
    }
    return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
  }, [dataStart, liveSignature, profileIds, rangeRuns]); // eslint-disable-line react-hooks/exhaustive-deps
  const byLane = useMemo(() => profiles.map((profile) => runs.filter((run) => run.profileId === profile.id)), [profiles, runs]);
  const deepMax = useMemo(() => deepMaxOf(runs), [runs]);

  // ── 引擎 ──
  useEffect(() => {
    const root = rootRef.current;
    const plot = plotRef.current;
    const base = baseRef.current;
    const live = liveRef.current;
    const ov = ovRef.current;
    const ovBox = ovBoxRef.current;
    if (!root || !plot || !base || !live || !ov || !ovBox) return;
    const engine = new WatchPulseEngine({
      root, plot, base, live, ov, ovBox, now,
      callbacks: {
        onView: setView,
        onLayout: (geoms, size) => { setLanes(geoms); setPlotSize(size); },
        onHover: setHover,
        onSelect: (run) => setSelected(run),
        onLaneHover: setLaneHover,
        onSecond: () => setTick((value) => value + 1)
      }
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [now]);

  useEffect(() => {
    engineRef.current?.setData(profiles, byLane, deepMax, dataStart);
  }, [byLane, dataStart, deepMax, profiles]);

  // 选中项跟随最新数据（运行中 → 已完成）。
  useEffect(() => {
    if (!selected) return;
    const fresh = runs.find((run) => run.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [runs, selected]);

  // ── 选中 / 抽屉 ──
  const loadDetail = useCallback(async (id: string, force = false) => {
    let skip = false;
    setDetails((current) => {
      if (!force && (current[id]?.detail || current[id]?.loading)) { skip = true; return current; }
      return { ...current, [id]: { ...current[id], loading: true, error: undefined } };
    });
    if (skip) return;
    try {
      const detail = await readDetail(id);
      setDetails((current) => ({ ...current, [id]: detail ? { detail } : { error: pulseText("runDetailMissing", "The run detail does not exist or has been cleaned up.", "运行详情不存在或已经被清理。") } }));
    } catch (error) {
      setDetails((current) => ({ ...current, [id]: { error: error instanceof Error ? error.message : String(error) } }));
    }
  }, [readDetail]);

  useEffect(() => {
    engineRef.current?.setSelected(selected);
    if (selected) void loadDetail(selected.id);
  }, [loadDetail, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 运行中的记录结束后重新读取详情（专家时间线、token 结算）。
  const selectedStatus = selected ? `${selected.status}:${selected.finishedAt ?? ""}` : "";
  const lastStatusRef = useRef(selectedStatus);
  useEffect(() => {
    const previous = lastStatusRef.current;
    lastStatusRef.current = selectedStatus;
    if (selected && previous && previous !== selectedStatus && previous.startsWith("running")) void loadDetail(selected.id, true);
  }, [loadDetail, selected, selectedStatus]);

  const laneRunsOf = useCallback((run: PulseRun) => byLane[profiles.findIndex((profile) => profile.id === run.profileId)] ?? [], [byLane, profiles]);
  const step = useCallback((delta: number) => {
    if (!selected) return;
    const lane = laneRunsOf(selected);
    const next = lane[lane.findIndex((run) => run.id === selected.id) + delta];
    if (next) setSelected(next);
  }, [laneRunsOf, selected]);

  // ── 键盘 ──
  useEffect(() => {
    if (suspendKeys) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (/^(input|textarea|select)$/i.test(active.tagName) || active.isContentEditable)) return;
      if (document.querySelector(".modal-backdrop")) return;
      const engine = engineRef.current;
      if (!engine || !rootRef.current?.isConnected) return;
      if (event.key === "Escape") { if (selected) setSelected(null); }
      else if (event.key === "ArrowLeft" && selected) { event.preventDefault(); step(-1); }
      else if (event.key === "ArrowRight" && selected) { event.preventDefault(); step(1); }
      else if (event.key === "1") engine.setWindow("24h");
      else if (event.key === "2") engine.setWindow("7d");
      else if (event.key === "s" || event.key === "S") engine.toggleSkips();
      else if (event.key === "End") engine.goNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, step, suspendKeys]);

  // ── 提示定位（原型 showTip） ──
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!tip || !hover) return;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = hover.ax + 14;
    if (x + tw > plotSize.w - 6) x = hover.ax - tw - 14;
    const y = Math.min(Math.max(hover.ay - th / 2, AXIS_H + 4), plotSize.h - th - 6);
    tip.style.left = `${Math.max(6, x)}px`;
    tip.style.top = `${y}px`;
  }, [hover, plotSize]);

  const n = now();
  const t0 = view?.t0 ?? n - DAY;
  const t1 = view?.t1 ?? n;
  const visA = Math.max(t0, dataStart);
  const visB = Math.min(t1, n);
  const visible = useMemo(() => runs.filter((run) => run.startedAt >= visA && run.startedAt <= visB), [runs, visA, visB]);
  const sum = useMemo(() => summarize(visible), [visible]);
  const span = visB - visA;
  const spanLabel = span >= DAY * 0.98
    ? pulseText("pulseSpanDays", "{{n}} d", "{{n}} 天", { n: (span / DAY).toFixed(span % DAY < HOUR ? 0 : 1) })
    : pulseText("pulseSpanHours", "{{n}} h", "{{n}} 小时", { n: (span / HOUR).toFixed(span < 3 * HOUR ? 1 : 0) });
  const until = t1 >= n ? pulseText("pulseNow", "Now", "现在") : fStamp(visB, n).slice(0, -3);
  const runningTotal = runs.filter((run) => run.status === "running").length;

  const laneStats = useMemo(() => byLane.map((laneRuns, i) => {
    const vis = laneRuns.filter((run) => run.startedAt >= visA && run.startedAt <= visB);
    const tri = vis.filter((run) => run.triage && run.triage.mode !== "off" && deepState(run) !== "na");
    return {
      total: vis.length,
      deep: tri.filter((run) => deepState(run) === "deep").length,
      triaged: tri.length,
      failed: vis.filter(isFailedRun).length,
      off: profiles[i]?.triage?.mode === "off"
    };
  }), [byLane, profiles, visA, visB]);

  const pressed = view?.pressed ?? null;
  const showSkips = view?.showSkips ?? true;
  const win = view?.win ?? "24h";
  const selectWindow = (next: PulseWindow) => engineRef.current?.setWindow(next);

  const hoverRun = hover?.kind === "run" ? hover.run : null;
  const hoverProfile = hover ? profiles[hover.lane] : null;

  return (
    <div
      ref={rootRef}
      className="watch-pulse"
      data-watch-pulse
      data-window={win}
      data-window-pressed={pressed ?? ""}
      data-show-skips={showSkips ? "true" : "false"}
      data-run-count={runs.length}
      data-range-loaded={rangeState.loaded ? "true" : "false"}
    >
      <div className="wp-bar">
        {toolbarStart}
        <span className="wp-bar__meta">
          {rangeState.loading && !rangeState.loaded ? pulseText("pulseLoading", "Loading 7 days of runs…", "正在读取 7 天运行记录…") : null}
          {rangeState.error ? <span className="wp-warn-text" title={rangeState.error}>{pulseText("pulseLoadFailed", "Range load failed; showing the latest runs", "区间读取失败，仅显示最新运行")}</span> : null}
          {rangeState.truncated ? <span className="wp-warn-text">{pulseText("pulseTruncated", "Too many runs; showing the most recent 5,000", "运行过多，仅显示最近 5000 条")}</span> : null}
        </span>
        <span className="wp-spacer" />
        {view && !view.atNow ? (
          <button type="button" className="wp-btn" onClick={() => engineRef.current?.goNow()} title={pulseText("pulseGoNowTitle", "Back to now (End)", "回到现在 (End)")} data-pulse-go-now>
            {pulseText("pulseGoNow", "Back to now", "回到现在")}
          </button>
        ) : null}
        <button type="button" className="wp-btn" aria-pressed={showSkips} onClick={() => engineRef.current?.toggleSkips()} title={pulseText("pulseShowSkipsTitle", "Show skipped triage runs (S)", "显示跳过的试判 (S)")} data-pulse-skips>
          {pulseText("pulseShowSkips", "Show skips", "显示跳过")}
        </button>
        <div className="wp-seg" role="group" aria-label={pulseText("pulseWindowAria", "Time window", "时间窗口")} data-pulse-window-toggle>
          <button type="button" aria-pressed={pressed === "24h"} onClick={() => selectWindow("24h")} title={pulseText("pulseWindow24hTitle", "Last 24 hours (1)", "近 24 小时 (1)")} data-pulse-window="24h">
            {pulseText("pulseWindow24h", "24 h", "24 小时")}
          </button>
          <button type="button" aria-pressed={pressed === "7d"} onClick={() => selectWindow("7d")} title={pulseText("pulseWindow7dTitle", "Last 7 days (2)", "近 7 天 (2)")} data-pulse-window="7d">
            {pulseText("pulseWindow7d", "7 d", "7 天")}
          </button>
        </div>
      </div>

      <section className="wp-sum" aria-live="polite" data-pulse-summary>
        <div className="wp-cell range">
          <div className="k">{pulseText("pulseVisibleRange", "Visible range", "可见范围")} <span className="wp-chip wp-num">{spanLabel}</span></div>
          <div className="v"><b>{fMD(visA)} {fHM(visA)} → {until}</b></div>
        </div>
        <div className="wp-cell">
          <div className="k">{pulseText("pulseRuns", "Runs", "运行")}<span className="rng-inline">· {spanLabel}</span></div>
          <div className="v"><b data-pulse-run-total>{sum.total}</b>
            <span>
              <span className="opt-c">{pulseText("pulseCompleted", "done", "完成")} <span className="wp-num">{sum.completed}</span> · </span>
              {pulseText("pulseSkipped", "skipped", "跳过")} <span className="wp-num">{sum.skipped}</span> · {pulseText("pulseFailed", "failed", "失败")} <span className={clsx("wp-num", sum.failed && "wn")}>{sum.failed}</span>
              {sum.running ? <> · <span className="ai">{pulseText("pulseRunningCount", "running {{n}}", "运行中 {{n}}", { n: sum.running })}</span></> : null}
            </span>
          </div>
        </div>
        <div className="wp-cell">
          <div className="k" title={pulseText("pulseDeepRatioHint", "Only runs with a triage verdict count; {{n}} runs without triage are excluded", "分母只含有试判判定的运行；未启用试判的 {{n}} 次不计入", { n: sum.off })}>
            {pulseText("pulseDeepRatio", "Deep / triaged", "进入深度 / 有试判")} <span className="wp-num">{sum.deep}/{sum.triaged}</span>
          </div>
          <div className="v"><b>{fPct(sum.deep, sum.triaged)}</b>
            <span>{pulseText("pulseEscalated", "escalated", "升级")} <span className="wp-num">{sum.escalated}</span> · {pulseText("pulseForced", "forced", "强制")} <span className="wp-num">{sum.forced}</span> · {pulseText("pulseSampled", "sampled", "抽样")} <span className="wp-num">{sum.sampled}</span></span>
          </div>
        </div>
        <div className="wp-cell">
          <div className="k">{pulseText("pulseTriageTokens", "Triage tokens", "试判 token")}</div>
          <div className="v"><b>{fTok(sum.triageTotal)}</b><span>{pulseText("pulseCacheRead", "cache read", "缓存读取")} <span className="wp-num">{fTok(sum.triageCache)}</span></span></div>
        </div>
        <div className="wp-cell">
          <div className="k">{pulseText("pulseDeepTokens", "Deep tokens", "深度 token")}</div>
          <div className="v"><b className="ai">{fTok(sum.deepTotal)}</b>
            <span>{pulseText("pulseCacheRead", "cache read", "缓存读取")} <span className="wp-num">{fTok(sum.deepCache)}</span>{sum.deepPending ? <> · <span className="wp-num">{sum.deepPending}</span> {pulseText("pulsePendingSettle", "pending", "待结算")}</> : null}</span>
          </div>
        </div>
        <div className="wp-cell">
          <div className="k">{pulseText("pulseActions", "Actions", "动作")}</div>
          <div className="v"><b>{sum.actions.trade + sum.actions.opportunity + sum.actions.notification + sum.actions.wake}</b>
            <span>
              {ACTION_KEYS.map((key) => <span className="gl" key={key}><GlyphSvg kind={key} /><span className="wp-num">{sum.actions[key]}</span></span>)}
            </span>
          </div>
        </div>
      </section>

      <section className={clsx("wp-stage", selected && "has-drawer")}>
        <div className="wp-board">
          <div className="wp-labels">
            <div className="axis-h"><span className="wp-micro">Profile</span></div>
            {profiles.map((profile, i) => {
              const L = lanes[i];
              if (!L) return null;
              const stats = laneStats[i];
              const wake = laneWake(profile, byLane[i] ?? []);
              const triMode = profile.triage?.mode ?? "off";
              return (
                <div
                  key={profile.id}
                  className={clsx("wp-lane", L.h < 118 && "is-compact", laneHover === i && "is-hover")}
                  style={{ top: L.top, height: L.h }}
                  onMouseEnter={() => setLaneHover(i)}
                  onMouseLeave={() => setLaneHover(-1)}
                  data-pulse-lane={profile.id}
                >
                  <div className="l1"><b title={profile.name} data-i18n-skip>{profile.name}</b><span className={clsx("env", profile.environment === "live" && "is-live")}>{profile.environment === "live" ? pulseText("pulseEnvLive", "Live", "实盘") : pulseText("pulseEnvDemo", "Demo", "模拟盘")}</span></div>
                  <div className="l2">{cadenceLabel(profile)} · {triMode === "off" ? pulseText("pulseTriageDisabled", "no triage", "未启用试判") : `${pulseText("pulseTriagePrefix", "triage", "试判")} ${triageModeLabel(triMode)}`}</div>
                  <div className="l3">
                    <span className="wp-num">{stats?.total ?? 0}</span> {pulseText("pulseTimes", "runs", "次")}
                    {stats?.off ? ` · ${pulseText("pulseAlwaysDeep", "always deep", "每次深度")}` : <> · {pulseText("pulseDeepShort", "deep", "深度")} <span className="wp-num">{fPct(stats?.deep ?? 0, stats?.triaged ?? 0)}</span></>}
                    {stats?.failed ? <> · <span className="wp-num wn">{stats.failed}</span> {pulseText("pulseFailed", "failed", "失败")}</> : null}
                  </div>
                  {wake.status === "running" || wake.status === "queued" ? (
                    <div className="l4 is-running"><LiveDot />{statusLabel(wake.status)} <span className="wp-num">{fCount(n - wake.run.startedAt)}</span></div>
                  ) : wake.status === "waiting" ? (
                    <div className="l4"><span className="ring" />{pulseText("pulseNextWake", "Next wake", "下次唤醒")} <span className="wp-num">{wake.target <= n ? pulseText("pulseDueSoon", "due now", "即将触发") : fCount(wake.target - n)}</span></div>
                  ) : (
                    <div className="l4">{pulseText("pulseNoRuns", "No runs", "无运行记录")}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div ref={plotRef} className="wp-plot" data-pulse-plot>
            <canvas ref={baseRef} data-pulse-base />
            <canvas ref={liveRef} data-pulse-canvas aria-label={pulseText("pulseCanvasAria", "Run timeline by Profile", "按 Profile 分泳道的运行时间轴")} role="img" />
            {profiles.length === 0 ? <div className="wp-empty">{pulseText("pulseNoProfiles", "No Profiles to show", "没有可显示的 Profile")}</div> : null}
            <div ref={tipRef} className={clsx("wp-tip", hover && "is-on", hover?.kind === "wake" && "is-wake")} role="tooltip" data-pulse-tip>
              {hover?.kind === "wake" && hoverProfile ? (
                <>
                  <div className="t1"><b>{pulseText("pulseNextWake", "Next wake", "下次唤醒")}</b><span data-i18n-skip>{hoverProfile.name}</span></div>
                  <div className="t2 wp-num">{fStamp(hover.target, n)} · {hover.target <= n ? pulseText("pulseDueNow", "due, triggering soon", "已到期，即将触发") : pulseText("pulseDueIn", "in {{t}}", "还有 {{t}}", { t: fCount(hover.target - n) })}</div>
                  <div className="hint">{pulseText("pulseWakeRule", "min(last run nextWakeAt, last activity + {{m}} min)", "取 min(上次运行的 nextWakeAt, 上次活动 + {{m}} 分钟)", { m: hoverProfile.scanIntervalMinutes })}</div>
                </>
              ) : hoverRun && hoverProfile ? (
                <>
                  <div className="t1"><b>{triggerLabel(hoverRun.triggerType)}</b><span data-i18n-skip>{hoverProfile.name}</span><StatusTag run={hoverRun} /></div>
                  <div className="t2 wp-num">{fStamp(hoverRun.startedAt, n)} → {hoverRun.finishedAt ? fHMS(hoverRun.finishedAt) : pulseText("pulseInProgress", "in progress", "进行中")} · {fDur((hoverRun.finishedAt ?? n) - hoverRun.startedAt)}</div>
                  <div className="vd"><TriageTags run={hoverRun} /></div>
                  <dl className="wp-num">
                    {hoverRun.triage ? <><dt>{pulseText("pulseTriageTokens", "Triage tokens", "试判 token")}</dt><dd>{tokLine(hoverRun.triage.triageUsage)}</dd></> : null}
                    {isDeep(hoverRun) || isFailedRun(hoverRun) ? <><dt>{pulseText("pulseDeepTokens", "Deep tokens", "深度 token")}</dt><dd>{tokLine(hoverRun.triage ? hoverRun.triage.deepUsage : hoverRun.tokenUsage, hoverRun.status === "running")}</dd></> : null}
                    {hoverRun.expertCount ? (
                      <><dt>{pulseText("pulseExperts", "Experts", "专家")}</dt><dd>{pulseText("pulseExpertsValue", "{{n}} · {{c}} tool calls", "{{n}} 位 · 工具调用 {{c}} 次", { n: hoverRun.expertCount, c: hoverRun.expertToolCalls })}</dd></>
                    ) : isDeep(hoverRun) ? (
                      <><dt>{pulseText("pulseExperts", "Experts", "专家")}</dt><dd><em>{pulseText("pulseNoExperts", "no experts", "未派专家")}</em></dd></>
                    ) : null}
                    <dt>{pulseText("pulseActions", "Actions", "动作")}</dt><dd><ActionsInline run={hoverRun} /></dd>
                  </dl>
                  {hoverRun.error ? <div className="err" data-i18n-skip>{hoverRun.error}</div> : null}
                  <div className="hint">{pulseText("pulseClickHint", "Click for triage evidence and the expert timeline", "点击查看试判证据与专家时间线")}</div>
                </>
              ) : null}
            </div>
          </div>
          <div className="wp-ovl"><b>{pulseText("pulseOverview", "7-day overview", "7 天总览")}</b><span>{pulseText("pulseOverviewHint", "Drag to pan · drag edges to zoom", "拖动选框平移 · 拖边缩放")}</span></div>
          <div ref={ovBoxRef} className="wp-ovc"><canvas ref={ovRef} data-pulse-overview /></div>
          <div className="wp-legend">
            <span className="it"><svg width="14" height="12" aria-hidden="true"><rect x="6" y="7" width="1.6" height="5" fill="var(--wp-ink-3)" opacity=".7" /><path d="M0 11.5h14" stroke="var(--wp-hair-3)" /></svg>{pulseText("pulseLegendSkip", "Triage skip", "试判跳过")}</span>
            <span className="it"><svg width="18" height="12" aria-hidden="true"><path d="M1 11.5L3 2h8l2 9.5" fill="var(--wp-ai-fill)" stroke="var(--wp-ai-hi)" /><path d="M0 11.5h18" stroke="var(--wp-hair-3)" /></svg>{pulseText("pulseLegendDeep", "Deep analysis · width = duration · height ∝ √deep tokens (full = {{max}})", "深度分析 · 宽 = 实际耗时 · 高 ∝ √深度 token（满格 {{max}}）", { max: fTok(deepMax) })}</span>
            <span className="it"><svg width="20" height="13" aria-hidden="true"><path d="M4 12.5L6 4h7l2 8.5" fill="var(--wp-ai-fill)" stroke="var(--wp-ai-hi)" /><path d="M1 12.5L4 1.2h11l3 11.3" fill="none" stroke="var(--wp-ink-2)" /></svg>{pulseText("pulseLegendForced", "Outline = forced escalation", "外框 = 强制升级")}</span>
            <span className="it"><svg width="18" height="12" aria-hidden="true"><path d="M1 11.5L3 3h8l2 8.5" fill="none" stroke="var(--wp-ai-hi)" strokeDasharray="3 2.5" /></svg>{pulseText("pulseLegendSampled", "Dashed = sampled re-check", "虚线 = 抽样复检")}</span>
            <span className="it"><svg width="14" height="14" aria-hidden="true"><path d="M2 3.5L7 12l5-8.5z" fill="var(--wp-warn-fill)" stroke="var(--wp-warn)" strokeWidth="1.2" strokeLinejoin="round" /></svg>{pulseText("pulseLegendFailed", "Failed", "失败")}</span>
            <span className="it"><LiveDot />{pulseText("pulseStatusRunning", "Running", "运行中")}</span>
            <span className="it"><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.2" fill="none" stroke="var(--wp-ink-2)" strokeWidth="1.3" /></svg>{pulseText("pulseNextWake", "Next wake", "下次唤醒")}</span>
            <span className="sep" />
            <span className="it opt">
              {ACTION_KEYS.map((key) => <span className="glyph-it" key={key}><GlyphSvg kind={key} size={9} />{key === "opportunity" ? pulseText("pulseLegendOpportunity", "Opportunity", "机会") : actionLabel(key)}</span>)}
            </span>
            <span className="spacer" />
            <span className="src">{pulseText("pulseLegendHint", "Wheel to zoom · drag to pan · double-click to reset", "滚轮缩放 · 拖动平移 · 双击复位")}</span>
          </div>
        </div>
        {selected ? (
          <PulseDrawer
            run={selected}
            profile={profiles.find((profile) => profile.id === selected.profileId) ?? null}
            laneRuns={laneRunsOf(selected)}
            state={details[selected.id]}
            now={n}
            onClose={() => setSelected(null)}
            onStep={step}
            onOpenFull={() => onOpenFullDetail(selected)}
            onRetry={() => void loadDetail(selected.id, true)}
          />
        ) : null}
      </section>
      <span className="wp-sr" aria-live="polite">{runningTotal ? pulseText("pulseRunningCount", "running {{n}}", "运行中 {{n}}", { n: runningTotal }) : ""}</span>
    </div>
  );
}

function PulseDrawer({
  run,
  profile,
  laneRuns,
  state,
  now: n,
  onClose,
  onStep,
  onOpenFull,
  onRetry
}: {
  run: PulseRun;
  profile: WatchPulseProfile | null;
  laneRuns: PulseRun[];
  state?: DetailState;
  now: number;
  onClose: () => void;
  onStep: (delta: number) => void;
  onOpenFull: () => void;
  onRetry: () => void;
}) {
  const full = state?.detail?.run ?? null;
  const t = run.triage;
  const fullTriage = full?.triage ?? null;
  const end = run.finishedAt ?? n;
  const idx = laneRuns.findIndex((item) => item.id === run.id);
  const dstate = deepState(run);
  const experts = Array.isArray(full?.experts) ? full!.experts! : [];
  const summaryText = full?.summary ?? null;
  const errorText = full?.error ?? run.error;
  const loading = !full && (state?.loading ?? true) && !state?.error;

  let triageBody: ReactNode;
  if (!t) {
    triageBody = <p className="note">{pulseText("pulseTriageOffNote", "This Profile has triage off (mode = off); every wake-up goes straight to deep analysis.", "本 Profile 未启用试判（mode = off），每次唤醒直接进入深度分析。")}</p>;
  } else if (loading) {
    triageBody = <p className="note">{pulseText("pulseReadingDetail", "Reading run detail…", "正在读取运行详情…")}</p>;
  } else {
    const reasons = (fullTriage?.reasons ?? []).filter(Boolean);
    const evidence = fullTriage?.evidence ?? [];
    triageBody = (
      <>
        {t.forcedBy.length && t.verdict === "skip" ? <p className="note">{pulseText("pulseForcedNote", "The model chose to skip; the hard-escalation list overruled it and forced a deep run.", "模型判定跳过，被硬升级清单否决并强制进入深度。")}</p> : null}
        {t.sampled ? <p className="note">{pulseText("pulseSampledNote", "The model chose to skip; the sampling rate {{rate}}% hit, so deep analysis still ran.", "模型判定跳过，按抽样复检率 {{rate}}% 命中，仍执行深度。", { rate: Math.round((profile?.triage?.skipSampleRate ?? 0) * 100) })}</p> : null}
        {reasons.length ? (
          <ul className="reasons" data-i18n-skip>{reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
        ) : (
          <p className="note">{pulseText("pulseNoReasons", "No triage reasons were submitted.", "未提交试判理由。")}</p>
        )}
        {evidence.length ? (
          <div className="evi" data-i18n-skip>
            {evidence.map((item, i) => {
              const at = Date.parse(item.at);
              return <div key={i}><p>{item.fact}</p><code>{item.source}</code><time>{Number.isFinite(at) ? fHMS(at) : item.at}</time></div>;
            })}
          </div>
        ) : null}
      </>
    );
  }

  let gantt: ReactNode = null;
  if (isDeep(run) || isFailedRun(run)) {
    if (loading) {
      gantt = <p className="note">{pulseText("pulseReadingDetail", "Reading run detail…", "正在读取运行详情…")}</p>;
    } else if (!experts.length) {
      const reason = full?.audit?.selfAnalysisReason;
      gantt = <p className="note">{reason ? <>{pulseText("pulseNoExpertsReason", "No experts: ", "未派专家：")}<span data-i18n-skip>{reason}</span></> : pulseText("pulseNoExpertsRun", "No experts were dispatched in this run.", "本轮未派专家。")}</p>;
    } else {
      const s0 = run.startedAt;
      const spanMs = Math.max(1, end - s0);
      const pos = (a: number) => Math.min(100, Math.max(0, ((a - s0) / spanMs) * 100));
      gantt = (
        <>
          <div className="gantt">
            <div className="gr">
              <div className="n">{pulseText("pulseWholeRun", "Whole run", "整轮")}<small>{statusLabel(run.status)}</small></div>
              <div className="tr"><i className="is-whole" style={{ left: 0, width: "100%" }} /></div>
              <div className="m">{fDur(end - s0)}</div>
            </div>
            {experts.map((expert, i) => {
              const live = expert.endedAt == null && run.status === "running";
              const e1 = expert.endedAt ?? n;
              const start = typeof expert.startedAt === "number" ? expert.startedAt : null;
              const name = expert.name ?? expert.expertName ?? expert.expertId ?? "—";
              return (
                <div className="gr" key={`${expert.agentId ?? expert.expertId ?? i}`}>
                  <div className="n" title={name}><span data-i18n-skip>{name}</span><small>{expert.mode === "serial" ? pulseText("pulseSerial", "serial", "串行") : pulseText("pulseParallel", "parallel", "并行")}</small></div>
                  <div className="tr">{start !== null ? <i className={live ? "is-live" : ""} style={{ left: `${pos(start)}%`, width: `${Math.max(0.8, pos(e1) - pos(start))}%` }} /> : null}</div>
                  <div className="m">{live ? pulseText("pulseInProgress", "in progress", "进行中") : expert.durationMs != null || start !== null ? fDur(expert.durationMs ?? e1 - (start ?? e1)) : "--"}<br />{pulseText("pulseToolCalls", "{{n}} tools", "{{n}} 次工具", { n: expert.toolCalls ?? "--" })}</div>
                </div>
              );
            })}
          </div>
          <div className="gaxis"><span /><div><span>{fHMS(s0)}</span><span>{run.finishedAt ? fHMS(end) : pulseText("pulseNow", "Now", "现在")}</span></div><span /></div>
        </>
      );
    }
  }

  const tokRow = (label: string, u: AiAutomationPulseTokens | null | undefined, pending = false) => u ? (
    <tr><td>{label}</td><td>{fTok(u.inputTokens)}</td><td>{fTok(u.cacheReadTokens)}</td><td>{fTok(u.outputTokens)}</td><td>{fTok(u.totalTokens)}</td></tr>
  ) : (
    <tr><td>{label}</td><td className="na" colSpan={4}>{pending ? pulseText("pulseSettleLater", "running, settles when finished", "进行中，结束后结算") : "--"}</td></tr>
  );
  const toolCallsTotal = experts.reduce((total, expert) => total + (expert.toolCalls ?? 0), 0);

  return (
    <aside className="wp-drawer" aria-label={pulseText("pulseDrawerAria", "Run detail", "运行详情")} data-pulse-drawer data-run-id={run.id}>
      <div className="dh">
        <div className="r1">
          <StatusTag run={run} />
          <b data-i18n-skip>{profile?.name ?? run.profileId}</b>
          <button type="button" className="wp-btn wp-btn--ghost x" onClick={onClose} title={pulseText("pulseCloseTitle", "Close (Esc)", "关闭 (Esc)")} aria-label={pulseText("pulseClose", "Close", "关闭")} data-pulse-drawer-close>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="r2"><span className="wp-num" data-i18n-skip>{run.id}</span><span>{pulseText("pulseTriggeredBy", "{{trigger}} trigger", "{{trigger}}触发", { trigger: triggerLabel(run.triggerType) })}</span></div>
        <div className="r3">
          <TriageTags run={run} />
          {dstate === "deep" || dstate === "off" ? <span className="wp-tag is-deep">{run.status === "running" ? pulseText("pulseDeepRunning", "Deep analysis running", "深度分析中") : pulseText("pulseDeepEntered", "Entered deep", "进入深度")}</span> : null}
        </div>
        <div className="r4">
          <div><span>{pulseText("pulseStart", "Start", "开始")}{sameDay(run.startedAt, n) ? "" : ` · ${fMD(run.startedAt)}`}</span><b>{fHMS(run.startedAt)}</b></div>
          <div><span>{pulseText("pulseEnd", "End", "结束")}{run.finishedAt && !sameDay(run.finishedAt, n) ? ` · ${fMD(run.finishedAt)}` : ""}</span><b>{run.finishedAt ? fHMS(run.finishedAt) : pulseText("pulseInProgress", "in progress", "进行中")}</b></div>
          <div><span>{pulseText("pulseDuration", "Duration", "耗时")}</span><b>{fDur(end - run.startedAt)}</b></div>
        </div>
      </div>
      <div className="db">
        {state?.error ? (
          <div className="sec"><div className="summary is-err">{state.error} <button type="button" className="wp-btn wp-btn--inline" onClick={onRetry}>{pulseText("pulseRetry", "Retry", "重试")}</button></div></div>
        ) : null}
        {summaryText || errorText ? (
          <div className="sec">
            <h5>{errorText ? pulseText("pulseError", "Error", "错误") : pulseText("pulseSummary", "Summary", "摘要")}</h5>
            {errorText ? (
              <div className="summary is-err" style={{ marginTop: 0 }} data-i18n-skip>{errorText}</div>
            ) : (
              <div className="summary is-md" style={{ marginTop: 0 }} data-pulse-summary-md><AiMarkdown content={normalizeRunMarkdown(summaryText ?? "")} /></div>
            )}
          </div>
        ) : null}
        <div className="sec">
          <h5>{pulseText("pulseTriage", "Triage", "试判")}<em>{t ? pulseText("pulseTriageMeta", "mode {{mode}} · {{n}} evidence", "模式 {{mode}} · 证据 {{n}} 项", { mode: triageModeLabel(t.mode), n: fullTriage?.evidence?.length ?? 0 }) : pulseText("pulseDisabled", "off", "未启用")}</em></h5>
          {triageBody}
        </div>
        {gantt ? (
          <div className="sec">
            <h5>{pulseText("pulseExpertTimeline", "Expert timeline", "专家时间线")}<em>{pulseText("pulseExpertMeta", "{{n}} · {{c}} tool calls", "{{n}} 位 · 工具调用 {{c}} 次", { n: experts.length || run.expertCount, c: experts.length ? toolCallsTotal : run.expertToolCalls })}</em></h5>
            {gantt}
          </div>
        ) : null}
        <div className="sec">
          <h5>Token<em>{pulseText("pulseCacheIncluded", "cache reads are included in input", "缓存读取已含在输入")}</em></h5>
          <table className="tok">
            <thead><tr><th /><th>{pulseText("pulseInput", "Input", "输入")}</th><th>{pulseText("pulseCacheReadShort", "Cache", "缓存读")}</th><th>{pulseText("pulseOutput", "Output", "输出")}</th><th>{pulseText("pulseTotal", "Total", "合计")}</th></tr></thead>
            <tbody>
              {t ? (
                <>
                  {tokRow(pulseText("pulseTriage", "Triage", "试判"), t.triageUsage)}
                  {isDeep(run) || t.deepUsage ? tokRow(pulseText("pulseDeep", "Deep", "深度"), t.deepUsage, run.status === "running") : null}
                </>
              ) : tokRow(pulseText("pulseDeep", "Deep", "深度"), run.tokenUsage, run.status === "running")}
            </tbody>
          </table>
        </div>
        <div className="sec">
          <h5>{pulseText("pulseActions", "Actions", "动作")}<em>{pulseText("pulseFromActionCounts", "from actionCounts", "来自 actionCounts")}</em></h5>
          <div className="acts">
            {ACTION_KEYS.map((key) => (
              <div key={key} className={run.actionCounts[key] ? "" : "is-zero"}><GlyphSvg kind={key} size={9} />{actionLabel(key)}<b>{run.actionCounts[key] || 0}</b></div>
            ))}
          </div>
        </div>
      </div>
      <div className="df">
        <button type="button" className="wp-btn" disabled={idx <= 0} onClick={() => onStep(-1)} title={pulseText("pulsePrevTitle", "Previous (←)", "上一条 (←)")} data-pulse-prev>←</button>
        <button type="button" className="wp-btn" disabled={idx < 0 || idx >= laneRuns.length - 1} onClick={() => onStep(1)} title={pulseText("pulseNextTitle", "Next (→)", "下一条 (→)")} data-pulse-next>→</button>
        <span className="pos">{idx + 1} / {laneRuns.length}</span>
        <span className="wp-spacer" />
        <button type="button" className="wp-btn wp-btn--ai" onClick={onOpenFull} data-pulse-open-full>{pulseText("pulseOpenFull", "Open full run detail", "打开完整运行详情")}</button>
      </div>
    </aside>
  );
}
