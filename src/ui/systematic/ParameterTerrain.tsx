// 参数地形图 · Parameter terrain for Strategy Research → Parameter optimization.
//
// Ported from the approved prototype viz/prototypes/parameter-terrain.html:
// any two tuned parameters become the axes, measured candidates are crisp
// dots, a Gaussian-kernel field (visual aid only) shows the validation Calmar
// landscape, and the side panel explains robustness, train/validation gap and
// per-parameter sensitivity before a parameter set is applied.
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  listenSystematicEvents,
  loadSystematicOptimizationCandidates,
  type SystematicOptimizationCandidatesView,
  type SystematicOptimizationView,
} from "../../lib/systematic";
import { TerminalSelect } from "../TerminalSelect";
import {
  FIELD_H,
  GAP_HI,
  GMAX,
  LUT_CALMAR,
  LUT_GAP,
  WARN_RGB,
  buildTerrainCandidates,
  buildTerrainParams,
  clamp,
  computeTerrainField,
  contourInterval,
  contourLevels,
  contourSegments,
  deriveTerrain,
  formatParam,
  gapT,
  gradientCss,
  lutCss,
  nu,
  rasterizeField,
  sampleField,
  scheduleReplay,
  sensitivityModel,
  statusAt,
  valueDomain,
  type ContourSegment,
  type TerrainCandidate,
  type TerrainDerived,
  type TerrainField,
  type TerrainNeighbors,
  type TerrainParam,
  type TerrainStatus,
} from "./parameterTerrainModel";
import "./parameter-terrain.css";

const SYNTHETIC_AXIS = "__none__";
const REPLAY_SECONDS = 13;
const PAD = { l: 58, r: 18, t: 54, b: 42 };

type Marg = "best" | "median";
type ColorBy = "calmar" | "gap";

export type ParameterTerrainProps = Readonly<{
  chinese: boolean;
  /** Optimizations for the current strategy and contract, newest first. */
  optimizations: readonly SystematicOptimizationView[];
  strategyName: string;
  desktop: boolean;
  onConfigure: () => void;
  onApply: (optimizationId: string, parameters: Record<string, unknown>) => void;
  onBacktest: (optimizationId: string, parameters: Record<string, unknown>) => void;
  onCancel: (optimizationId: string) => void;
  cancellingOptimizationId: string | null;
  applyingOptimizationId: string | null;
}>;

function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

const minus = (s: string) => s.replace(/^-/, "−");
const fmtC = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : minus(v.toFixed(d)));
const fmtPct = (v: number | null | undefined, sign = true) => (v == null ? "—" : `${sign ? (v >= 0 ? "+" : "−") : ""}${Math.abs(v).toFixed(1)}%`);
const fmtMs = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtDateTime = (ms: number) => {
  const d = new Date(ms);
  return `${fmtDate(ms)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function terrainCopy(chinese: boolean) {
  if (chinese) {
    return {
      title: "参数地形图", recordAria: "调优记录", configure: "配置调优", current: "当前", train: "训练", validation: "验证",
      budgetFast: "快速", budgetStandard: "标准", budgetDeep: "深入", groups: "组",
      statusCompleted: "已完成", statusRunning: "运行中", statusPaused: "已暂停（重放）", statusQueued: "排队中", statusCancelled: "已取消", statusFailed: "失败", statusCancelling: "正在取消",
      candidatesUnit: "组候选", stripTitle: "按候选序号排列；点击选中", stripBaseline: "#0 基线", stripCap: "{valid} 有效 · {invalid} 无效/失败 · {running} 运行中",
      elapsed: "已用时", eta: "预计剩余", workers: "并发", space: "组合空间", sampled: "抽样", grid: "全网格",
      bestTitle: "当前最佳 · 验证 Calmar", baseline: "基线", replay: "重放调优过程", pause: "暂停", resume: "继续", spaceKey: "空格", replayHint: "重放调优过程（空格）", cancel: "取消调优",
      xAxis: "X 轴参数", yAxis: "Y 轴参数", swap: "交换坐标轴 (X)", otherDims: "其余维度", margAria: "其余维度的边缘化方式", margBest: "取最优", margMedian: "取中位",
      margBestHint: "每处取隐藏维度中验证 Calmar 最高的候选（软最大）", margMedianHint: "每处取附近候选的加权中位数",
      colorBy: "着色", colorAria: "着色指标", colorCalmar: "验证 Calmar", colorGap: "过拟合差距", hatch: "过拟合层", hatchHint: "差距大的区域叠加斜线 (O)",
      hudGap: "训练−验证差距", hudProjected: "· {n} 个有效实测点投影到 {x} × {y}", hudNote: "插值仅用于可视化 · 圆点为实测候选", noHidden: "无", listSep: "、",
      gapLegend: "差距（稳健标准分）", measured: "实测", queued: "待测", running: "运行中", invalid: "验证交易 < 10", failed: "失败",
      baselineGlyph: "基线", bestGlyph: "最佳验证", robustGlyph: "稳健推荐", threshold: "阈值", best: "最佳",
      method: "高斯核 h = {h} · 远离实测点处淡出", methodContour: " · 等值线间隔 {i}",
      measuredTag: "实测", interpTitle: "插值估计", interpTag: "非实测", noData: "无数据", density: "数据密度", sparse: "稀疏", medium: "中", dense: "密",
      interpNote: "仅用于可视化；应用参数前请看最近的实测点", sameSpot: "另有 {n} 个候选投影到同一位置（其余维度不同）", trainCalmar: "训练 Calmar", validationCalmar: "验证 Calmar", gapShort: "差距",
      completedInvalid: "已完成 · 验证交易不足", completedFlat: "已完成 · 验证段无回撤",
      labelBaseline: "基线 #0", labelBest: "最佳验证 #{i}", labelRobust: "稳健推荐 #{i}", axisStep: "{key}（步长 {step}）",
      rank: "验证排名", notScored: "验证交易 < 10，不计分", flatScored: "验证段无回撤，不计分", vsBaseline: "较基线",
      tagFragile: "邻域脆弱", tagGapHigh: "过拟合差距高",
      robustness: "稳健度 · 邻域实测", nbCount: "{n} 个实测邻居 · 距离 ≤ {r}", widened: "（已放宽）",
      nbHint: "邻居 = 参数空间内最近的已完成候选（每维按网格归一化），非插值；地形图上以连线标出",
      nbMedian: "邻域中位", vsSelf: "较自身", grade: "评估", gradeRobust: "稳健", gradeFair: "一般", gradeFragile: "脆弱", robCap: "◆ 此候选 · ▏邻居 · ╷中位",
      trainVsVal: "训练 vs 验证", trainSub: "70% · {d} 天", valSub: "30% · {d} 天", rowReturn: "收益", rowDd: "最大回撤", rowTrades: "交易次数", rowWin: "胜率", rowSharpe: "年化夏普",
      gapRow: "过拟合差距", gapHint: "训练与验证时长不同（70/30），先各自按全体候选的中位数/MAD 标准化再相减",
      paramsSec: "参数", paramName: "名称", thisCandidate: "此候选", deltaCol: "Δ", rangeHint: "范围 {min}–{max} · 步长 {step}",
      sensSec: "单参数敏感度", sensHint: "其余参数按与此候选的距离加权 · 非额外回测", sensRead: "±1 步 {a} · ±2 步 {b}", sensNone: "附近无实测",
      warnFragile: "邻域中位仅 {m}（较自身 −{p}%）", warnGap: "训练段显著强于验证段（差距 {g}）", warnJoin: "，且", warnTail: "，更像一次性的尖峰而非稳定区域。建议先以此为基线独立回测。",
      viewRobust: "查看稳健推荐 #{i}", okNote: "邻域 {n} 个实测候选的中位 Calmar 为 {m}，参数小幅偏移时表现基本保持。", pendingNote: "候选尚未完成，完成后才能应用或回测。",
      apply: "应用此参数", backtest: "以此为基线回测", saving: "正在保存…",
      fine: "应用会把此候选的参数保存为新的策略版本；回测会先保存该版本，再打开回测设置按完整区间运行，不复用调优结果。",
      loading: "正在读取调优候选…", loadFailed: "无法读取调优候选", noCandidates: "暂无候选", oneParam: "只有一个调优参数，纵轴不可用；可在配置调优中再选择一个参数。",
      noValid: "暂无有效实测点", runFailed: "调优失败",
    };
  }
  return {
    title: "Parameter terrain", recordAria: "Optimization run", configure: "Configure tuning", current: "current", train: "Train", validation: "Validation",
    budgetFast: "Fast", budgetStandard: "Standard", budgetDeep: "Deep", groups: "",
    statusCompleted: "Completed", statusRunning: "Running", statusPaused: "Paused (replay)", statusQueued: "Queued", statusCancelled: "Cancelled", statusFailed: "Failed", statusCancelling: "Cancelling",
    candidatesUnit: "candidates", stripTitle: "Ordered by candidate index; click to select", stripBaseline: "#0 baseline", stripCap: "{valid} valid · {invalid} invalid/failed · {running} running",
    elapsed: "Elapsed", eta: "ETA", workers: "Workers", space: "Space", sampled: "sampled", grid: "full grid",
    bestTitle: "Best so far · validation Calmar", baseline: "Baseline", replay: "Replay tuning", pause: "Pause", resume: "Resume", spaceKey: "Space", replayHint: "Replay the tuning run (Space)", cancel: "Cancel optimization",
    xAxis: "X-axis parameter", yAxis: "Y-axis parameter", swap: "Swap axes (X)", otherDims: "Other dims", margAria: "How hidden dimensions are collapsed", margBest: "Best", margMedian: "Median",
    margBestHint: "Soft-maximum of validation Calmar over the hidden dimensions", margMedianHint: "Kernel-weighted median of nearby candidates",
    colorBy: "Color", colorAria: "Color metric", colorCalmar: "Validation Calmar", colorGap: "Overfit gap", hatch: "Overfit layer", hatchHint: "Hatch regions with a large gap (O)",
    hudGap: "Train − validation gap", hudProjected: "· {n} measured points projected onto {x} × {y}", hudNote: "Interpolation is visual only · dots are measured candidates", noHidden: "none", listSep: ", ",
    gapLegend: "Gap (robust z)", measured: "Measured", queued: "Queued", running: "Running", invalid: "< 10 val. trades", failed: "Failed",
    baselineGlyph: "Baseline", bestGlyph: "Best validation", robustGlyph: "Robust pick", threshold: "threshold", best: "best",
    method: "Gaussian kernel h = {h} · fades away from measurements", methodContour: " · contours every {i}",
    measuredTag: "measured", interpTitle: "Interpolated estimate", interpTag: "not measured", noData: "No data", density: "Data density", sparse: "sparse", medium: "medium", dense: "dense",
    interpNote: "Visual only; check the nearest measured point before applying", sameSpot: "{n} more candidates project here (other dims differ)", trainCalmar: "Train Calmar", validationCalmar: "Validation Calmar", gapShort: "Gap",
    completedInvalid: "Completed · too few validation trades", completedFlat: "Completed · no validation drawdown",
    labelBaseline: "Baseline #0", labelBest: "Best validation #{i}", labelRobust: "Robust pick #{i}", axisStep: "{key} (step {step})",
    rank: "Validation rank", notScored: "fewer than 10 validation trades, not scored", flatScored: "no validation drawdown, not scored", vsBaseline: "vs baseline",
    tagFragile: "Fragile neighbourhood", tagGapHigh: "High overfit gap",
    robustness: "Robustness · measured neighbours", nbCount: "{n} neighbours · distance ≤ {r}", widened: " (widened)",
    nbHint: "Neighbours are the nearest completed candidates in parameter space (grid-normalised), not interpolation; lines on the terrain mark them",
    nbMedian: "Neighbour median", vsSelf: "vs self", grade: "Verdict", gradeRobust: "Robust", gradeFair: "Fair", gradeFragile: "Fragile", robCap: "◆ this · ▏neighbours · ╷median",
    trainVsVal: "Train vs validation", trainSub: "70% · {d} d", valSub: "30% · {d} d", rowReturn: "Return", rowDd: "Max drawdown", rowTrades: "Trades", rowWin: "Win rate", rowSharpe: "Ann. Sharpe",
    gapRow: "Overfit gap", gapHint: "Train and validation lengths differ (70/30), so each is standardised by the median/MAD of all candidates before subtracting",
    paramsSec: "Parameters", paramName: "Name", thisCandidate: "This", deltaCol: "Δ", rangeHint: "Range {min}–{max} · step {step}",
    sensSec: "Single-parameter sensitivity", sensHint: "Other parameters weighted by distance to this candidate · no extra backtests", sensRead: "±1 step {a} · ±2 steps {b}", sensNone: "No measurements nearby",
    warnFragile: "The neighbour median is only {m} ({p}% below this candidate)", warnGap: "the training segment is much stronger than validation (gap {g})", warnJoin: ", and ", warnTail: ". This looks like a one-off spike rather than a stable region; backtest it independently first.",
    viewRobust: "View robust pick #{i}", okNote: "The median Calmar of {n} measured neighbours is {m}; small parameter shifts keep performance broadly intact.", pendingNote: "This candidate has not finished; it can be applied or backtested once complete.",
    apply: "Apply parameters", backtest: "Backtest from here", saving: "Saving…",
    fine: "Apply saves this candidate's parameters as a new strategy version; backtest saves that version and opens backtest settings for a full-range run that does not reuse tuning results.",
    loading: "Loading optimization candidates…", loadFailed: "Could not load optimization candidates", noCandidates: "No candidates yet", oneParam: "Only one tuned parameter, so the Y axis is empty; add another parameter in Configure tuning.",
    noValid: "No valid measured points yet", runFailed: "Optimization failed",
  };
}

type Copy = ReturnType<typeof terrainCopy>;

function statusText(text: Copy, status: string) {
  switch (status) {
    case "completed": return text.statusCompleted;
    case "running": return text.statusRunning;
    case "queued": return text.statusQueued;
    case "cancelled": return text.statusCancelled;
    case "cancelling": return text.statusCancelling;
    case "failed": return text.statusFailed;
    default: return status;
  }
}

function candidateStatusLabel(text: Copy, st: TerrainStatus, c: TerrainCandidate) {
  if (st === "queued") return text.statusQueued;
  if (st === "running") return text.statusRunning;
  if (st === "failed") return text.statusFailed;
  if (st === "cancelled") return text.statusCancelled;
  if (c.validationCalmar == null) return c.validationCalmarReason === "noDrawdown" ? text.completedFlat : text.completedInvalid;
  return text.statusCompleted;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ── Canvas helpers (ported from the prototype) ───────────────────
type Geom = { ctx: CanvasRenderingContext2D; dpr: number; w: number; h: number; pw: number; ph: number; x0: number; y0: number };

function fitCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, dpr, w: rect.width, h: rect.height };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
  ctx.strokeStyle = "rgba(5,6,11,0.9)"; ctx.lineWidth = 4; ctx.stroke();
  ctx.strokeStyle = "rgba(244,244,250,0.95)"; ctx.lineWidth = 1.4; ctx.stroke();
}

function axisChip(ctx: CanvasRenderingContext2D, font: string, text: string, x: number, y: number, axis: "x" | "y") {
  ctx.font = `600 10.5px ${font}`;
  const tw = ctx.measureText(text).width + 8, th = 15;
  const rx = axis === "x" ? x - tw / 2 : x - tw, ry = axis === "x" ? y : y - th / 2;
  ctx.fillStyle = "rgba(244,244,250,1)"; roundRect(ctx, rx, ry, tw, th, 2); ctx.fill();
  ctx.fillStyle = "rgba(5,6,11,1)"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, rx + tw / 2, ry + th / 2 + 0.5);
}

function ticks(p: TerrainParam, maxN: number) {
  let every = 1;
  while (p.n / every > maxN) every += 1;
  const out: number[] = [];
  for (let i = 0; i < p.n; i += every) out.push(p.values[i]);
  return out;
}

type RenderState = {
  params: TerrainParam[];
  cands: TerrainCandidate[];
  D: TerrainDerived;
  field: TerrainField | null;
  fieldCanvas: HTMLCanvasElement | null;
  maskCanvas: HTMLCanvasElement | null;
  contours: { level: number; segs: ContourSegment[] }[];
  gapEdge: ContourSegment[];
  vmin: number;
  vmax: number;
  x: number;
  y: number;
  colorBy: ColorBy;
  hatch: boolean;
  sel: number | null;
  text: Copy;
};

// ── Component ────────────────────────────────────────────────────
export function ParameterTerrain(props: ParameterTerrainProps) {
  const { chinese, optimizations, strategyName, onConfigure, onApply, onBacktest, onCancel, cancellingOptimizationId, applyingOptimizationId } = props;
  const text = useMemo(() => terrainCopy(chinese), [chinese]);
  const newestId = optimizations[0]?.id ?? "";
  const [selectedId, setSelectedId] = useState(newestId);
  const lastNewest = useRef(newestId);
  useEffect(() => {
    if (newestId !== lastNewest.current) { lastNewest.current = newestId; setSelectedId(newestId); }
  }, [newestId]);
  const optimization = optimizations.find((item) => item.id === selectedId) ?? optimizations[0] ?? null;
  const optimizationId = optimization?.id ?? "";
  const active = optimization ? ["queued", "running", "cancelling"].includes(optimization.status) : false;

  // ── Data: candidates + incremental events ──
  const [data, setData] = useState<SystematicOptimizationCandidatesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const load = useCallback(async (id: string) => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    try {
      const view = await loadSystematicOptimizationCandidates(id);
      if (seq !== requestSeq.current) return;
      setData(view);
      setLoadError(null);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => {
    if (optimizationId) void load(optimizationId);
  }, [load, optimizationId, optimization?.completedCount, optimization?.status]);

  const idRef = useRef(optimizationId);
  idRef.current = optimizationId;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let refetchTimer: number | null = null;
    const scheduleRefetch = () => {
      if (refetchTimer !== null) return;
      refetchTimer = window.setTimeout(() => { refetchTimer = null; if (idRef.current) void load(idRef.current); }, 450);
    };
    void listenSystematicEvents((event) => {
      if (!event.optimizationId || event.optimizationId !== idRef.current) return;
      if (event.type === "optimizationProgress" && typeof event.candidateIndex === "number") {
        const index = event.candidateIndex;
        const status = event.candidateStatus ?? "completed";
        setData((prev) => {
          if (!prev || prev.optimization.id !== event.optimizationId) return prev;
          const candidates = prev.candidates.map((candidate) => {
            if (candidate.index !== index) return candidate;
            if (status === "running" && candidate.status !== "queued") return candidate;
            return { ...candidate, status, validationCalmar: status === "completed" ? event.validationCalmar ?? null : candidate.validationCalmar };
          });
          return { ...prev, candidates };
        });
        if (status !== "running") scheduleRefetch();
      } else if (event.type === "optimizationFinished") {
        scheduleRefetch();
      }
    }).then((stop) => {
      if (disposed) stop?.();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
      if (refetchTimer !== null) window.clearTimeout(refetchTimer);
    };
  }, [load]);

  const view = data && data.optimization.id === optimizationId ? data : null;

  // ── Model ──
  const params = useMemo(() => {
    if (!view) return [] as TerrainParam[];
    const built = buildTerrainParams(view);
    if (built.length === 1) {
      built.push({ key: SYNTHETIC_AXIS, kind: "int", decimals: 0, min: 0, max: 0, step: 1, base: 0, n: 1, values: [0], lo: -0.5, hi: 0.5 });
    }
    return built;
  }, [view]);
  const realParams = useMemo(() => params.filter((p) => p.key !== SYNTHETIC_AXIS), [params]);
  const cands = useMemo(() => (view ? buildTerrainCandidates(view, params) : []), [view, params]);
  const [vmin, vmax] = useMemo(() => valueDomain(cands), [cands]);
  const tEnd = useMemo(() => scheduleReplay(cands, optimization?.startedAt, optimization?.workerCount), [cands, optimization?.startedAt, optimization?.workerCount]);

  // Replay: time lives in a ref; React re-renders only when a status changes.
  const RM = useMemo(() => reducedMotion(), []);
  const replayRef = useRef<{ t: number | null; last: number }>({ t: null, last: 0 });
  const [playing, setPlaying] = useState(false);
  const [replayKey, setReplayKey] = useState("final");
  const replayKeyRef = useRef("final");
  const statusKeyAt = useCallback((t: number | null) => (t == null ? "final" : cands.map((c) => statusAt(c, t, tEnd).slice(0, 2)).join("")), [cands, tEnd]);
  const statuses = useMemo<TerrainStatus[]>(() => {
    const t = replayRef.current.t;
    return t == null ? cands.map((c) => c.status) : cands.map((c) => statusAt(c, t, tEnd));
    // replayKey intentionally drives recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cands, tEnd, replayKey]);
  const D = useMemo(() => deriveTerrain(cands, statuses), [cands, statuses]);

  const stopReplay = useCallback(() => {
    replayRef.current.t = null;
    replayKeyRef.current = "final";
    setPlaying(false);
    setReplayKey("final");
  }, []);
  useEffect(() => { stopReplay(); }, [optimizationId, stopReplay]);
  const togglePlay = useCallback(() => {
    if (active || !cands.length) return;
    const r = replayRef.current;
    if (playing) { setPlaying(false); return; }
    if (r.t == null || r.t >= tEnd) { r.t = 0; popAt.current.clear(); }
    r.last = performance.now();
    const key = statusKeyAt(r.t);
    replayKeyRef.current = key;
    setReplayKey(key);
    setPlaying(true);
  }, [active, cands.length, playing, statusKeyAt, tEnd]);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // ── View state ──
  const [axes, setAxes] = useState<{ x: number; y: number }>({ x: 0, y: 1 });
  const [marg, setMarg] = useState<Marg>("best");
  const [colorBy, setColorBy] = useState<ColorBy>("calmar");
  const [hatch, setHatch] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => {
    setAxes((current) => (current.x < params.length && current.y < params.length && current.x !== current.y ? current : { x: 0, y: Math.min(1, Math.max(0, params.length - 1)) }));
  }, [params.length]);
  useEffect(() => { setSel(null); }, [optimizationId]);
  useEffect(() => {
    if (!cands.length) return;
    if (sel == null || !cands.some((c) => c.index === sel)) {
      const pick = D.best ?? D.running[0] ?? cands[0];
      setSel(pick.index);
    }
  }, [D.best, D.running, cands, sel]);
  const x = Math.min(axes.x, Math.max(0, params.length - 1));
  const y = Math.min(axes.y, Math.max(0, params.length - 1));
  const setAxesSafe = useCallback((nx: number, ny: number) => { if (nx !== ny) setAxes({ x: nx, y: ny }); }, []);

  // ── Field (visual aid) ──
  const field = useMemo(() => (params.length >= 2 && D.valid.length ? computeTerrainField(D, params[x], params[y], marg) : null), [D, params, x, y, marg]);
  const rasters = useMemo(() => {
    if (!field) return null;
    const { img, mask } = rasterizeField(field, colorBy, vmin, vmax);
    const make = (buffer: Uint8ClampedArray) => {
      const canvas = document.createElement("canvas");
      canvas.width = field.nx; canvas.height = field.ny;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const image = ctx.createImageData(field.nx, field.ny);
        image.data.set(buffer);
        ctx.putImageData(image, 0, 0);
      }
      return canvas;
    };
    return { fieldCanvas: make(img), maskCanvas: make(mask) };
  }, [field, colorBy, vmin, vmax]);
  const contours = useMemo(() => (field && colorBy === "calmar" ? contourSegments(field.val, field.alpha, field.nx, field.ny, contourLevels(vmin, vmax)) : []), [field, colorBy, vmin, vmax]);
  const gapEdge = useMemo(() => (field ? contourSegments(field.gap, field.alpha, field.nx, field.ny, [GAP_HI])[0]?.segs ?? [] : []), [field]);

  // ── Canvas plumbing ──
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const geomRef = useRef<Geom | null>(null);
  const hatchRef = useRef<{ canvas: HTMLCanvasElement | null; dirty: boolean }>({ canvas: null, dirty: true });
  const dirtyRef = useRef(true);
  const hoverRef = useRef<{ index: number | null; field: { x: number; y: number } | null }>({ index: null, field: null });
  const popAt = useRef(new Map<number, number>());
  const prevStatuses = useRef<TerrainStatus[] | null>(null);
  const renderRef = useRef<RenderState | null>(null);
  renderRef.current = {
    params, cands, D, field, fieldCanvas: rasters?.fieldCanvas ?? null, maskCanvas: rasters?.maskCanvas ?? null,
    contours, gapEdge, vmin, vmax, x, y, colorBy, hatch, sel, text,
  };
  useEffect(() => { hatchRef.current.dirty = true; }, [rasters]);
  useEffect(() => { dirtyRef.current = true; });

  // Completion "pop" while replaying or live.
  useEffect(() => {
    const prev = prevStatuses.current;
    if (prev && prev.length === statuses.length && !RM) {
      const now = performance.now();
      statuses.forEach((s, i) => { if (s === "completed" && prev[i] !== "completed") popAt.current.set(i, now); });
    }
    prevStatuses.current = statuses;
  }, [RM, statuses]);

  const cX = (r: RenderState, g: Geom, c: TerrainCandidate) => g.x0 + nu(r.params[r.x], c.params[r.params[r.x].key]) * g.pw;
  const cY = (r: RenderState, g: Geom, c: TerrainCandidate) => g.y0 + (1 - nu(r.params[r.y], c.params[r.params[r.y].key])) * g.ph;

  const geom = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const fit = fitCanvas(canvas);
    if (!fit) return null;
    const pw = Math.max(40, fit.w - PAD.l - PAD.r), ph = Math.max(40, fit.h - PAD.t - PAD.b);
    geomRef.current = { ...fit, pw, ph, x0: PAD.l, y0: PAD.t };
    hatchRef.current.dirty = true;
    return geomRef.current;
  }, []);

  const buildHatch = useCallback((g: Geom, mask: HTMLCanvasElement) => {
    const { dpr, pw, ph } = g;
    const hc = hatchRef.current.canvas ?? document.createElement("canvas");
    hatchRef.current.canvas = hc;
    hc.width = Math.max(1, Math.round(pw * dpr)); hc.height = Math.max(1, Math.round(ph * dpr));
    const h = hc.getContext("2d");
    if (!h) return;
    h.clearRect(0, 0, hc.width, hc.height);
    const pat = document.createElement("canvas"), s = Math.round(7 * dpr);
    pat.width = pat.height = s;
    const pc = pat.getContext("2d");
    if (!pc) return;
    pc.strokeStyle = "rgba(243,178,60,0.62)"; pc.lineWidth = 1.1 * dpr;
    pc.beginPath(); pc.moveTo(-1, s + 1); pc.lineTo(s + 1, -1); pc.moveTo(-1, 1); pc.lineTo(1, -1); pc.moveTo(s - 1, s + 1); pc.lineTo(s + 1, s - 1); pc.stroke();
    const pattern = h.createPattern(pat, "repeat");
    if (pattern) h.fillStyle = pattern;
    h.fillRect(0, 0, hc.width, hc.height);
    h.globalCompositeOperation = "destination-in";
    h.imageSmoothingEnabled = true; h.imageSmoothingQuality = "high";
    h.drawImage(mask, 0, 0, hc.width, hc.height);
    h.globalCompositeOperation = "source-over";
    hatchRef.current.dirty = false;
  }, []);

  const draw = useCallback((now: number) => {
    const r = renderRef.current;
    const g = geomRef.current ?? geom();
    if (!r || !g) return;
    const { ctx, w, h, x0, y0, pw, ph } = g;
    ctx.clearRect(0, 0, w, h);
    if (r.params.length < 2) return;
    const px = r.params[r.x], py = r.params[r.y];
    const rootStyle = rootRef.current ? getComputedStyle(rootRef.current) : null;
    const numFont = rootStyle?.getPropertyValue("--pt-font-num").trim() || "ui-monospace, monospace";
    const uiFont = rootStyle?.fontFamily || "sans-serif";
    const X = (v: number) => x0 + nu(px, v) * pw;
    const Y = (v: number) => y0 + (1 - nu(py, v)) * ph;
    const { D: d, cands: cs } = r;

    ctx.fillStyle = "rgba(10,11,18,1)";
    ctx.fillRect(x0, y0, pw, ph);
    const tx = ticks(px, Math.max(4, Math.floor(pw / 70))), ty = ticks(py, Math.max(4, Math.floor(ph / 44)));
    ctx.strokeStyle = "rgba(200,200,230,0.05)"; ctx.lineWidth = 1;
    ctx.beginPath();
    tx.forEach((v) => { const xx = Math.round(X(v)) + 0.5; ctx.moveTo(xx, y0); ctx.lineTo(xx, y0 + ph); });
    ty.forEach((v) => { const yy = Math.round(Y(v)) + 0.5; ctx.moveTo(x0, yy); ctx.lineTo(x0 + pw, yy); });
    ctx.stroke();

    // Field + contours + overfit layer
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, pw, ph); ctx.clip();
    if (r.fieldCanvas && r.field) {
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(r.fieldCanvas, x0, y0, pw, ph);
      const nx = r.field.nx, ny = r.field.ny;
      const gx = (i: number) => x0 + ((i + 0.5) / nx) * pw, gy = (j: number) => y0 + (1 - (j + 0.5) / ny) * ph;
      r.contours.forEach(({ level, segs }) => {
        const zero = Math.abs(level) < 1e-9;
        ctx.strokeStyle = zero ? "rgba(5,6,11,0.55)" : "rgba(5,6,11,0.32)";
        ctx.lineWidth = zero ? 1.2 : 0.8;
        ctx.setLineDash(zero ? [3, 3] : []);
        ctx.beginPath();
        segs.forEach(([a, b]) => { ctx.moveTo(gx(a[0]), gy(a[1])); ctx.lineTo(gx(b[0]), gy(b[1])); });
        ctx.stroke();
      });
      ctx.setLineDash([]);
      const showHatch = r.hatch && r.colorBy === "calmar";
      if (showHatch && r.maskCanvas) {
        if (hatchRef.current.dirty || !hatchRef.current.canvas) buildHatch(g, r.maskCanvas);
        if (hatchRef.current.canvas) ctx.drawImage(hatchRef.current.canvas, x0, y0, pw, ph);
      }
      if (showHatch || r.colorBy === "gap") {
        ctx.strokeStyle = r.colorBy === "gap" ? "rgba(244,244,250,0.5)" : "rgba(243,178,60,0.85)";
        ctx.lineWidth = 1.1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        r.gapEdge.forEach(([a, b]) => { ctx.moveTo(gx(a[0]), gy(a[1])); ctx.lineTo(gx(b[0]), gy(b[1])); });
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();

    // Frame, ticks, axis titles
    ctx.strokeStyle = "rgba(200,200,230,0.13)";
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw - 1, ph - 1);
    ctx.font = `10.5px ${numFont}`;
    ctx.fillStyle = "rgba(126,128,150,1)";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    tx.forEach((v) => ctx.fillText(formatParam(px, v), X(v), y0 + ph + 6));
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    if (py.key !== SYNTHETIC_AXIS) ty.forEach((v) => ctx.fillText(formatParam(py, v), x0 - 7, Y(v)));
    ctx.font = `11px ${uiFont}`;
    ctx.fillStyle = "rgba(185,186,203,1)";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText(fill(r.text.axisStep, { key: px.key, step: formatParam(px, px.step) }), x0 + pw / 2, y0 + ph + 34);
    if (py.key !== SYNTHETIC_AXIS) {
      ctx.save();
      ctx.translate(15, y0 + ph / 2); ctx.rotate(-Math.PI / 2);
      ctx.fillText(fill(r.text.axisStep, { key: py.key, step: formatParam(py, py.step) }), 0, 0);
      ctx.restore();
    }

    const byIndex = new Map(cs.map((c, i) => [c.index, i]));
    const selPos = r.sel != null ? byIndex.get(r.sel) : undefined;
    const sel = selPos != null ? cs[selPos] : null;
    const selDone = sel && d.st[selPos as number] === "completed" && sel.validationCalmar != null;
    if (sel) {
      const sx = cX(r, g, sel), sy = cY(r, g, sel);
      ctx.strokeStyle = "rgba(244,244,250,0.22)"; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, y0 + ph); ctx.moveTo(sx, sy); ctx.lineTo(x0, sy); ctx.stroke();
      ctx.setLineDash([]);
      axisChip(ctx, numFont, formatParam(px, sel.params[px.key]), sx, y0 + ph + 4, "x");
      if (py.key !== SYNTHETIC_AXIS) axisChip(ctx, numFont, formatParam(py, sel.params[py.key]), x0 - 4, sy, "y");
      if (selDone) {
        const nb = d.neighbors(sel);
        ctx.strokeStyle = "rgba(244,244,250,0.3)"; ctx.lineWidth = 1;
        nb.list.forEach(({ c }) => { ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cX(r, g, c), cY(r, g, c)); ctx.stroke(); });
      }
    }

    // Measured / queued / failed dots
    const nbSet = selDone && sel ? new Set(d.neighbors(sel).list.map((o) => o.c.index)) : new Set<number>();
    const rankOrder = (i: number) => {
      const st = d.st[i];
      return st === "queued" ? 0 : st === "failed" || st === "cancelled" ? 1 : cs[i].validationCalmar == null ? 2 : 3 + ((cs[i].validationCalmar as number) - r.vmin) / 10;
    };
    const order = cs.map((_, i) => i).sort((a, b) => rankOrder(a) - rankOrder(b));
    for (const i of order) {
      const c = cs[i], st = d.st[i];
      const xx = cX(r, g, c), yy = cY(r, g, c);
      if (st === "queued") {
        ctx.strokeStyle = "rgba(200,200,230,0.26)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(xx, yy, 2.6, 0, Math.PI * 2); ctx.stroke();
        continue;
      }
      if (st === "running") continue;
      if (st === "failed" || st === "cancelled") {
        ctx.strokeStyle = st === "failed" ? "rgba(126,128,150,0.9)" : "rgba(126,128,150,0.5)"; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(xx - 3, yy - 3); ctx.lineTo(xx + 3, yy + 3); ctx.moveTo(xx + 3, yy - 3); ctx.lineTo(xx - 3, yy + 3); ctx.stroke();
        continue;
      }
      let rad = 4;
      const pa = popAt.current.get(i);
      if (pa != null) {
        const k = clamp((now - pa) / 380, 0, 1);
        rad *= 1 + 0.45 * (1 - k) * (1 - k);
        if (k >= 1) popAt.current.delete(i);
      }
      if (c.validationCalmar == null) {
        ctx.fillStyle = "rgba(5,6,11,0.85)";
        ctx.beginPath(); ctx.arc(xx, yy, rad + 0.6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(126,128,150,1)"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(xx, yy, rad - 0.4, 0, Math.PI * 2); ctx.moveTo(xx - 2.3, yy + 2.3); ctx.lineTo(xx + 2.3, yy - 2.3); ctx.stroke();
        continue;
      }
      const gv = d.gap.get(c.index);
      const fillColor = r.colorBy === "gap" ? lutCss(LUT_GAP, gapT(gv ?? 0)) : lutCss(LUT_CALMAR, (c.validationCalmar - r.vmin) / (r.vmax - r.vmin));
      ctx.fillStyle = "rgba(5,6,11,0.92)";
      ctx.beginPath(); ctx.arc(xx, yy, rad + 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = fillColor;
      ctx.beginPath(); ctx.arc(xx, yy, rad, 0, Math.PI * 2); ctx.fill();
      if (r.hatch && r.colorBy === "calmar" && gv != null && gv > GAP_HI) {
        ctx.strokeStyle = WARN_RGB; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.arc(xx, yy, rad + 3, 0, Math.PI * 2); ctx.stroke();
      }
      if (nbSet.has(c.index)) {
        ctx.strokeStyle = "rgba(244,244,250,0.75)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(xx, yy, rad + 3.2, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // Markers: baseline / best validation / robust pick
    const labels: { x: number; y: number; t: string }[] = [];
    const basePos = byIndex.get(0);
    if (d.base && basePos != null && d.st[basePos] !== "queued") {
      const bx = cX(r, g, d.base), by = cY(r, g, d.base);
      ctx.strokeStyle = "rgba(5,6,11,0.9)"; ctx.lineWidth = 4; ctx.strokeRect(bx - 6.5, by - 6.5, 13, 13);
      ctx.strokeStyle = "rgba(244,244,250,0.95)"; ctx.lineWidth = 1.4; ctx.strokeRect(bx - 6.5, by - 6.5, 13, 13);
      labels.push({ x: bx, y: by, t: r.text.labelBaseline });
    }
    if (d.best) {
      const bx = cX(r, g, d.best), by = cY(r, g, d.best);
      diamond(ctx, bx, by, 8.5);
      labels.push({ x: bx, y: by, t: fill(r.text.labelBest, { i: d.best.index }) });
    }
    if (d.robust && d.robust !== d.best) {
      const bx = cX(r, g, d.robust), by = cY(r, g, d.robust);
      ctx.strokeStyle = "rgba(5,6,11,0.9)"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(bx, by, 8.5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(244,244,250,0.95)"; ctx.lineWidth = 1.4; ctx.setLineDash([2.2, 2.2]); ctx.beginPath(); ctx.arc(bx, by, 8.5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      labels.push({ x: bx, y: by, t: fill(r.text.labelRobust, { i: d.robust.index }) });
    }

    // Running: the only glowing element
    const pulse = RM ? 0.5 : 0.5 + 0.5 * Math.sin(now / 260);
    d.running.forEach((c) => {
      const rx = cX(r, g, c), ry = cY(r, g, c);
      ctx.save();
      ctx.fillStyle = "rgba(106,176,236,0.16)";
      ctx.beginPath(); ctx.arc(rx, ry, 9 + 3 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = "rgba(106,176,236,1)"; ctx.shadowBlur = 12 + 8 * pulse;
      ctx.strokeStyle = "rgba(106,176,236,1)"; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(rx, ry, 5.5 + 1.8 * pulse, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "rgba(185,220,247,1)";
      ctx.beginPath(); ctx.arc(rx, ry, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });

    if (sel) {
      const sx = cX(r, g, sel), sy = cY(r, g, sel);
      ctx.strokeStyle = "rgba(5,6,11,0.9)"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(sx, sy, 12, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(244,244,250,1)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx, sy, 12, 0, Math.PI * 2); ctx.stroke();
    }
    const hover = hoverRef.current;
    if (hover.index != null && hover.index !== r.sel) {
      const hp = byIndex.get(hover.index);
      if (hp != null) {
        const c = cs[hp];
        ctx.strokeStyle = "rgba(244,244,250,0.7)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cX(r, g, c), cY(r, g, c), 9, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // Labels with dark plates and simple collision avoidance
    ctx.font = `500 10.5px ${uiFont}`;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    labels.forEach((l) => {
      const tw = ctx.measureText(l.t).width + 12, th = 17;
      const opts: [number, number][] = [[13, -th - 6], [13, 6], [-tw - 13, -th - 6], [-tw - 13, 6]];
      let best: { x: number; y: number; w: number; h: number } | null = null;
      for (const [dx, dy] of opts) {
        const rect = { x: l.x + dx, y: l.y + dy, w: tw, h: th };
        const inside = rect.x > x0 + 2 && rect.x + rect.w < x0 + pw - 2 && rect.y > y0 + 2 && rect.y + rect.h < y0 + ph - 2;
        const clash = placed.some((q) => !(rect.x + rect.w < q.x || q.x + q.w < rect.x || rect.y + rect.h < q.y || q.y + q.h < rect.y));
        if (inside && !clash) { best = rect; break; }
        if (!best && inside) best = rect;
      }
      const at = best ?? { x: l.x + 13, y: l.y - th - 6, w: tw, h: th };
      placed.push(at);
      ctx.fillStyle = "rgba(10,11,18,0.9)";
      roundRect(ctx, at.x, at.y, at.w, at.h, 3); ctx.fill();
      ctx.strokeStyle = "rgba(200,200,230,0.22)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "rgba(244,244,250,1)"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(l.t, at.x + 6, at.y + th / 2 + 0.5);
    });

    if (hover.field && hover.index == null) {
      ctx.strokeStyle = "rgba(244,244,250,0.5)"; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.arc(hover.field.x, hover.field.y, 5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
  }, [RM, buildHatch, geom]);

  // Main loop: advance replay, redraw when dirty or animating.
  const tEndRef = useRef(tEnd);
  tEndRef.current = tEnd;
  const elapsedRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let raf = 0;
    const frame = (now: number) => {
      const replay = replayRef.current;
      if (playingRef.current && replay.t != null) {
        const dt = (now - replay.last) / 1000;
        replay.last = now;
        const r = renderRef.current;
        const span = Math.max(0.1, tEndRef.current);
        replay.t = Math.min(span, replay.t + dt * (span / REPLAY_SECONDS));
        if (replay.t >= span) {
          replay.t = null;
          playingRef.current = false;
          setPlaying(false);
          replayKeyRef.current = "final";
          setReplayKey("final");
        } else if (r) {
          const key = r.cands.map((c) => statusAt(c, replay.t as number, span).slice(0, 2)).join("");
          if (key !== replayKeyRef.current) { replayKeyRef.current = key; setReplayKey(key); }
        }
        if (elapsedRef.current && replay.t != null) elapsedRef.current.textContent = fmtMs(replay.t * 1000);
      }
      const r = renderRef.current;
      const animating = Boolean(r && ((r.D.running.length > 0 && !RM) || popAt.current.size > 0));
      // Skip painting while the workspace is hidden; repaint once it is shown again.
      const visible = Boolean(canvasRef.current && canvasRef.current.getClientRects().length > 0);
      if (visible && (dirtyRef.current || animating)) { draw(now); dirtyRef.current = false; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame((n) => { replayRef.current.last = n; raf = requestAnimationFrame(frame); });
    return () => cancelAnimationFrame(raf);
  }, [RM, draw]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const observer = new ResizeObserver(() => { geom(); dirtyRef.current = true; });
    observer.observe(plot);
    return () => observer.disconnect();
  }, [geom, view]);

  // ── Hover / click ──
  const pick = useCallback((mx: number, my: number) => {
    const r = renderRef.current, g = geomRef.current;
    if (!r || !g || r.params.length < 2) return null;
    let best: number | null = null, bd = 11 * 11;
    r.cands.forEach((c, i) => {
      const d2 = (cX(r, g, c) - mx) ** 2 + (cY(r, g, c) - my) ** 2;
      const pr = r.D.st[i] === "queued" ? 4 : 0;
      if (d2 + pr < bd) { bd = d2 + pr; best = c.index; }
    });
    return best;
  }, []);

  const showTip = useCallback((mx: number, my: number) => {
    const tip = tipRef.current, plot = plotRef.current, r = renderRef.current, g = geomRef.current;
    if (!tip || !plot || !r || !g) return;
    const px = r.params[r.x], py = r.params[r.y];
    const t = r.text;
    const hover = hoverRef.current;
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] as string));
    const shown = r.params.filter((p) => p.key !== SYNTHETIC_AXIS);
    if (hover.index != null) {
      const pos = r.cands.findIndex((c) => c.index === hover.index);
      const c = r.cands[pos], st = r.D.st[pos];
      const same = r.cands.filter((o, i) => o !== c && o.params[px.key] === c.params[px.key] && o.params[py.key] === c.params[py.key] && r.D.st[i] !== "queued").length;
      tip.className = "pt-tip is-on";
      tip.innerHTML = `<div class="t1"><b class="pt-num">#${c.index}</b><span>${esc(candidateStatusLabel(t, st, c))} · ${esc(t.measuredTag)}</span></div>
        <dl class="pt-num">${shown.map((p) => `<dt>${esc(p.key)}</dt><dd>${formatParam(p, c.params[p.key])}</dd>`).join("")}
        ${st === "completed" ? `<dt>${esc(t.validationCalmar)}</dt><dd class="hi">${fmtC(c.validationCalmar)}</dd><dt>${esc(t.trainCalmar)}</dt><dd>${fmtC(c.trainCalmar)}</dd>` : ""}</dl>
        ${same ? `<div class="nt">${esc(fill(t.sameSpot, { n: same }))}</div>` : ""}`;
    } else if (hover.field && r.field) {
      const ux = (mx - g.x0) / g.pw, uy = 1 - (my - g.y0) / g.ph;
      const s = sampleField(r.field, ux, uy);
      const v = r.colorBy === "gap" ? s.gap : s.val;
      const vx = px.lo + ux * (px.hi - px.lo), vy = py.lo + uy * (py.hi - py.lo);
      tip.className = "pt-tip is-on is-interp";
      tip.innerHTML = `<div class="t1"><b>${esc(t.interpTitle)}</b><span>${esc(t.interpTag)}</span></div>
        <dl class="pt-num"><dt>${esc(px.key)}</dt><dd>≈ ${formatParam(px, vx)}</dd>${py.key !== SYNTHETIC_AXIS ? `<dt>${esc(py.key)}</dt><dd>≈ ${formatParam(py, vy)}</dd>` : ""}
        <dt>${esc(r.colorBy === "gap" ? t.gapShort : t.validationCalmar)}</dt><dd class="hi">${Number.isNaN(v) || s.alpha < 0.05 ? esc(t.noData) : `≈ ${fmtC(v)}`}</dd><dt>${esc(t.density)}</dt><dd>${esc(s.alpha < 0.25 ? t.sparse : s.alpha < 0.7 ? t.medium : t.dense)}</dd></dl>
        <div class="nt">${esc(t.interpNote)}</div>`;
    } else {
      tip.classList.remove("is-on");
      return;
    }
    const pw = plot.clientWidth, ph = plot.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
    let tx = mx + 16, ty = my + 14;
    if (tx + tw > pw - 8) tx = mx - tw - 16;
    if (ty + th > ph - 8) ty = my - th - 14;
    tip.style.left = `${Math.max(8, tx)}px`; tip.style.top = `${Math.max(8, ty)}px`;
  }, []);

  const onMouseMove = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const g = geomRef.current;
    if (!g) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const mx = event.clientX - rect.left, my = event.clientY - rect.top;
    const index = pick(mx, my);
    const inPlot = mx >= g.x0 && mx <= g.x0 + g.pw && my >= g.y0 && my <= g.y0 + g.ph;
    hoverRef.current = { index, field: index == null && inPlot ? { x: mx, y: my } : null };
    plotRef.current?.classList.toggle("is-hover", index != null);
    showTip(mx, my);
    dirtyRef.current = true;
  }, [pick, showTip]);
  const onMouseLeave = useCallback(() => {
    hoverRef.current = { index: null, field: null };
    tipRef.current?.classList.remove("is-on");
    dirtyRef.current = true;
  }, []);
  const onCanvasClick = useCallback(() => {
    const index = hoverRef.current.index;
    if (index != null) setSel(index);
  }, []);

  // ── Keyboard shortcuts (only while the terrain is visible) ──
  const keyState = useRef({ togglePlay, D, setAxesSafe, x, y });
  keyState.current = { togglePlay, D, setAxesSafe, x, y };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !root.isConnected || root.getClientRects().length === 0) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(input|select|textarea)$/i.test(target.tagName) || target.isContentEditable || target.closest("[role='listbox'],[role='menu'],[role='dialog']"))) return;
      const key = event.key.toLowerCase();
      if (target && target !== document.body && !root.contains(target)) {
        // Letter shortcuts still work from the lab tab strip; Space there must keep activating the focused control.
        const workspace = root.closest(".systematic-strategy-lab");
        if (event.key === " " || !workspace || !workspace.contains(target)) return;
      }
      if (event.key === " " && target && root.contains(target) && target.closest("button, [role='button'], a") && !target.closest(".pt-playbtn")) return;
      const s = keyState.current;
      if (event.key === " ") { event.preventDefault(); s.togglePlay(); }
      else if (key === "o") setHatch((v) => !v);
      else if (key === "x") s.setAxesSafe(s.y, s.x);
      else if (key === "m") setMarg((v) => (v === "best" ? "median" : "best"));
      else if (key === "g") setColorBy((v) => (v === "gap" ? "calmar" : "gap"));
      else if (key === "b" && s.D.best) setSel(s.D.best.index);
      else if (key === "r" && s.D.robust) setSel(s.D.robust.index);
      else if (key === "0") setSel(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Derived display values ──
  const total = cands.length || optimization?.candidateCount || 0;
  const doneCount = D.done.length;
  const finished = !active && replayRef.current.t == null;
  const replayT = replayRef.current.t;
  const elapsedMs = replayT != null ? replayT * 1000 : optimization?.elapsedMs ?? null;
  const etaMs = replayT != null
    ? (doneCount > 0 && doneCount < total ? (replayT * 1000 * (total - doneCount)) / doneCount : null)
    : active ? optimization?.estimatedRemainingMs ?? null : null;
  const gridTotal = realParams.reduce((acc, p) => acc * p.n, 1);
  const baseCandidate = D.base;
  const basePos = cands.findIndex((c) => c.index === 0);
  const baseDone = basePos >= 0 && D.st[basePos] === "completed" && baseCandidate?.validationCalmar != null;
  const selPos = sel != null ? cands.findIndex((c) => c.index === sel) : -1;
  const selected = selPos >= 0 ? cands[selPos] : null;
  const selStatus = selPos >= 0 ? D.st[selPos] : null;
  // The split is 70/30 by bar count, so the train start is inferred from the validation length.
  const trainStartAt = optimization ? optimization.trainEndAt - (optimization.validationEndAt - optimization.validationStartAt) * 7 / 3 : 0;
  const trainDays = optimization ? Math.max(0, Math.round((optimization.trainEndAt - trainStartAt) / 86_400_000)) : 0;
  const valDays = optimization ? Math.max(0, Math.round((optimization.validationEndAt - optimization.validationStartAt) / 86_400_000)) : 0;

  const runStatus = !optimization ? "queued"
    : replayT != null ? (playing ? "running" : "paused")
      : optimization.status;
  const runLabel = runStatus === "paused" ? text.statusPaused : statusText(text, runStatus);

  const recordOptions = optimizations.map((item, i) => {
    const budget = item.candidateBudget ?? item.candidateCount;
    const budgetLabel = budget === 30 ? text.budgetFast : budget === 300 ? text.budgetDeep : text.budgetStandard;
    return {
      value: item.id,
      label: `${fmtDateTime(item.createdAt)} · ${budgetLabel} ${budget}${text.groups ? ` ${text.groups}` : ""} · ${i === 0 ? text.current : statusText(text, item.status)}`,
    };
  });
  const axisOptions = (other: number) => realParams.map((p, d) => ({ value: String(d), label: p.key, disabled: d === other }));
  const hidden = realParams.filter((_, d) => d !== x && d !== y).map((p) => p.key);

  const onStripClick = (index: number) => setSel(index);

  const body: ReactNode = !optimization ? null : !view ? (
    <div className="pt-empty" role="status">{loadError ? `${text.loadFailed}: ${loadError}` : text.loading}</div>
  ) : null;

  return (
    <div className="parameter-terrain" ref={rootRef} data-testid="parameter-terrain">
      <div className="pt-head">
        <strong className="pt-head__title">{text.title}</strong>
        <span className="pt-chip"><b>{strategyName}</b></span>
        {optimization?.strategyVersion ? <span className="pt-chip pt-num">v{optimization.strategyVersion}</span> : null}
        {optimization ? <span className="pt-chip pt-num">{optimization.instId}</span> : null}
        <span className="pt-spacer" />
        {optimization ? (
          <span className="pt-win">
            <span className="seg"><i style={{ width: 44, background: "var(--pt-ink-3)" }} />{text.train} <span className="pt-num">{fmtDate(trainStartAt)} → {fmtDate(optimization.trainEndAt)}</span></span>
            <span className="seg"><i style={{ width: 19, background: "var(--pt-signal)" }} />{text.validation} <span className="pt-num">{fmtDate(optimization.validationStartAt)} → {fmtDate(optimization.validationEndAt)}</span></span>
          </span>
        ) : null}
        <TerminalSelect className="pt-select pt-select--record" value={optimizationId} options={recordOptions} onChange={setSelectedId} ariaLabel={text.recordAria} menuMinWidth={280} />
        <button className="pt-btn pt-btn--ghost" type="button" onClick={onConfigure}>{text.configure}</button>
      </div>

      <div className="pt-run">
        <span className={clsx("pt-badge", finished && optimization?.status !== "running" ? "is-done" : "is-run", optimization?.status === "failed" && "is-failed")}>
          <span className="pt-live" />{runLabel}
        </span>
        <div className="pt-count"><span className="pt-display" data-testid="terrain-done">{doneCount}</span><span className="of pt-num">/ {total}</span><small>{text.candidatesUnit}</small></div>
        <div className="pt-strip-wrap">
          <div className="pt-strip" title={text.stripTitle} style={{ gridTemplateColumns: `repeat(${Math.max(1, cands.length)}, minmax(0, 1fr))` }}>
            {cands.map((c, i) => {
              const st = D.st[i];
              const cls = st === "queued" ? "q" : st === "running" ? "r" : st === "failed" || st === "cancelled" ? "x" : c.validationCalmar == null ? "inv" : "";
              const bg = cls ? undefined : colorBy === "gap" ? lutCss(LUT_GAP, gapT(D.gap.get(c.index) ?? 0)) : lutCss(LUT_CALMAR, ((c.validationCalmar as number) - vmin) / (vmax - vmin));
              return (
                <i
                  key={c.index}
                  className={clsx(cls, sel === c.index && "is-sel")}
                  style={bg ? { background: bg } : undefined}
                  title={`#${c.index} · ${candidateStatusLabel(text, st, c)}${st === "completed" && c.validationCalmar != null ? ` · ${text.validationCalmar} ${fmtC(c.validationCalmar)}` : ""}`}
                  onClick={() => onStripClick(c.index)}
                />
              );
            })}
          </div>
          <div className="pt-strip-cap"><span>{text.stripBaseline}</span><span>{fill(text.stripCap, { valid: D.valid.length, invalid: D.done.length - D.valid.length, running: D.running.length })}</span><span>#{Math.max(0, cands.length - 1)}</span></div>
        </div>
        <div className="pt-kpis">
          <div className="pt-kpi"><span className="pt-micro">{text.elapsed}</span><b ref={elapsedRef}>{fmtMs(elapsedMs)}</b></div>
          <div className="pt-kpi"><span className="pt-micro">{text.eta}</span><b>{fmtMs(etaMs)}</b></div>
          <div className="pt-kpi k-workers"><span className="pt-micro">{text.workers}</span><b>{optimization?.workerCount ?? "—"}</b></div>
          <div className="pt-kpi k-sample"><span className="pt-micro">{text.space}</span><b>{total}<small>/ {gridTotal.toLocaleString("en-US")} · {optimization?.samplingMode === "sampled" ? text.sampled : text.grid}</small></b></div>
        </div>
        <div className="pt-bestcmp">
          <span className="pt-micro">{text.bestTitle}</span>
          <div className="v">
            <span className="pt-display">{D.best ? fmtC(D.best.validationCalmar) : "—"}</span>
            <span>{text.baseline} <span className="pt-num">{baseDone ? fmtC(baseCandidate?.validationCalmar) : "—"}</span></span>
            <span className="up">{D.best && baseDone && baseCandidate?.validationCalmar != null
              ? `${(D.best.validationCalmar as number) >= baseCandidate.validationCalmar ? "▲ " : "▼ "}${minus(((D.best.validationCalmar as number) - baseCandidate.validationCalmar).toFixed(2))}${D.best.index ? ` · #${D.best.index}` : ""}`
              : ""}</span>
          </div>
        </div>
        {active && optimization ? (
          <button className="pt-btn pt-playbtn" type="button" disabled={cancellingOptimizationId === optimization.id || optimization.status === "cancelling"} onClick={() => onCancel(optimization.id)}>
            <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1" /></svg>
            {optimization.status === "cancelling" ? text.statusCancelling : text.cancel}
          </button>
        ) : (
          <button className="pt-btn pt-playbtn" type="button" title={text.replayHint} disabled={!cands.length} onClick={togglePlay} data-testid="terrain-replay">
            {playing
              ? <><svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2.5" y="2" width="2.4" height="8" rx=".6" /><rect x="7.1" y="2" width="2.4" height="8" rx=".6" /></svg>{text.pause}</>
              : replayT != null
                ? <><svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.8v8.4L10 6z" /></svg>{text.resume}</>
                : <><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M10 6a4 4 0 11-1.2-2.85" /><path d="M9.3 1.4v2.2H7.1" /></svg>{text.replay}</>}
            {" "}<span className="pt-kbd">{text.spaceKey}</span>
          </button>
        )}
      </div>

      {body ?? (
        <div className="pt-stage">
          <section className="pt-terrain">
            <div className="pt-tb">
              <div className="axes">
                <label><span className="pt-micro">X</span><TerminalSelect className="pt-select" value={String(x)} options={axisOptions(y)} onChange={(v) => setAxesSafe(Number(v), y)} ariaLabel={text.xAxis} disabled={realParams.length < 1} /></label>
                <button className="pt-btn swap" type="button" title={text.swap} aria-label={text.swap} disabled={realParams.length < 2} onClick={() => setAxesSafe(y, x)}>⇄</button>
                <label><span className="pt-micro">Y</span><TerminalSelect className="pt-select" value={String(y)} options={axisOptions(x)} onChange={(v) => setAxesSafe(x, Number(v))} ariaLabel={text.yAxis} disabled={realParams.length < 2} /></label>
              </div>
              <span className="sep" />
              <div className="grp"><span className="lbl">{text.otherDims}</span>
                <div className="pt-seg" role="group" aria-label={text.margAria}>
                  <button type="button" aria-pressed={marg === "best"} title={text.margBestHint} onClick={() => setMarg("best")}>{text.margBest}</button>
                  <button type="button" aria-pressed={marg === "median"} title={text.margMedianHint} onClick={() => setMarg("median")}>{text.margMedian}</button>
                </div>
              </div>
              <div className="grp"><span className="lbl">{text.colorBy}</span>
                <div className="pt-seg" role="group" aria-label={text.colorAria}>
                  <button type="button" aria-pressed={colorBy === "calmar"} onClick={() => setColorBy("calmar")}>{text.colorCalmar}</button>
                  <button type="button" aria-pressed={colorBy === "gap"} onClick={() => setColorBy("gap")}>{text.colorGap}</button>
                </div>
              </div>
              <button className="pt-btn pt-hatchbtn" type="button" aria-pressed={hatch} disabled={colorBy === "gap"} title={text.hatchHint} onClick={() => setHatch((v) => !v)} data-testid="terrain-hatch"><span className="sw" />{text.hatch}</button>
              <span className="pt-spacer" />
            </div>
            <div className="pt-plot" ref={plotRef}>
              <canvas ref={canvasRef} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave} onClick={onCanvasClick} data-testid="terrain-canvas" />
              <div className="pt-hud">
                <div className="l1"><b>{colorBy === "gap" ? text.hudGap : text.colorCalmar}</b><span>{fill(text.hudProjected, { n: D.valid.length, x: params[x]?.key ?? "", y: params[y]?.key === SYNTHETIC_AXIS ? "—" : params[y]?.key ?? "" })}</span></div>
                <div className="l2">
                  <span className="pt-tag">{text.otherDims}<em>{hidden.length ? hidden.join(text.listSep) : text.noHidden}</em>{marg === "best" ? text.margBest : text.margMedian}</span>
                  <span className="pt-tag">{text.hudNote}</span>
                  {realParams.length === 1 ? <span className="pt-tag is-warn">{text.oneParam}</span> : null}
                  {!D.valid.length ? <span className="pt-tag">{text.noValid}</span> : null}
                </div>
              </div>
              <div className="pt-tip" ref={tipRef} />
            </div>
            <Legend text={text} colorBy={colorBy} vmin={vmin} vmax={vmax} D={D} baseDone={baseDone} />
          </section>
          <aside className="pt-side" aria-live="polite">
            <div className="pt-side-scroll" data-testid="terrain-side">
              {selected && selStatus ? (
                <SidePanel text={text} c={selected} st={selStatus} D={D} params={realParams} allParams={params} axisX={x} axisY={y} vmin={vmin} vmax={vmax} trainDays={trainDays} valDays={valDays} />
              ) : <div className="pt-empty">{text.noCandidates}</div>}
            </div>
            <Actions
              text={text}
              c={selected}
              st={selStatus}
              D={D}
              applying={applyingOptimizationId === optimization?.id}
              onSelect={setSel}
              onApply={() => { if (optimization && selected) onApply(optimization.id, selected.parameters); }}
              onBacktest={() => { if (optimization && selected) onBacktest(optimization.id, selected.parameters); }}
            />
          </aside>
        </div>
      )}
      {optimization?.status === "failed" && optimization.error ? <div className="pt-runerror" role="alert">{text.runFailed}: {optimization.error}</div> : null}
    </div>
  );
}

function Legend({ text, colorBy, vmin, vmax, D, baseDone }: Readonly<{ text: Copy; colorBy: ColorBy; vmin: number; vmax: number; D: TerrainDerived; baseDone: boolean }>) {
  const gap = colorBy === "gap";
  const lut = gap ? LUT_GAP : LUT_CALMAR;
  const pos = (v: number) => (gap ? gapT(v) : clamp((v - vmin) / (vmax - vmin), 0, 1)) * 100;
  return (
    <div className="pt-legend">
      <span className="pt-cbar">
        <span className="pt-num">{gap ? "≤0" : fmtC(vmin, 1)}</span>
        <span className="bar" style={{ background: gradientCss(lut) }}>
          {gap ? <u style={{ left: `${pos(GAP_HI)}%` }} data-l={text.threshold} /> : null}
          {!gap && baseDone && D.base?.validationCalmar != null ? <u style={{ left: `${pos(D.base.validationCalmar)}%` }} data-l={text.baseline} /> : null}
          {!gap && D.best?.validationCalmar != null ? <u style={{ left: `${pos(D.best.validationCalmar)}%` }} data-l={text.best} /> : null}
        </span>
        <span className="pt-num">{gap ? `${GMAX}+` : fmtC(vmax, 1)}</span>
        <span>{gap ? text.gapLegend : text.colorCalmar}</span>
      </span>
      <span className="pt-glyphs">
        <span><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.6" fill={lutCss(lut, 0.7)} stroke="#05060b" strokeWidth="1.4" /></svg>{text.measured}</span>
        <span className="g-q"><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="2.6" fill="none" stroke="rgba(200,200,230,.4)" /></svg>{text.queued}</span>
        <span><svg viewBox="0 0 12 12"><circle className="glow" cx="6" cy="6" r="4" fill="none" stroke="var(--pt-signal)" strokeWidth="1.5" /></svg>{text.running}</span>
        <span className="g-inv"><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.3" fill="none" stroke="#7e8096" strokeWidth="1.2" /><path d="M3.8 8.2L8.2 3.8" stroke="#7e8096" strokeWidth="1.2" /></svg>{text.invalid}</span>
        <span className="g-x"><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="#7e8096" strokeWidth="1.3" /></svg>{text.failed}</span>
        <span><svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="#f4f4fa" strokeWidth="1.3" /></svg>{text.baselineGlyph}</span>
        <span><svg viewBox="0 0 12 12"><path d="M6 .5L11.5 6 6 11.5.5 6z" fill="none" stroke="#f4f4fa" strokeWidth="1.3" /></svg>{text.bestGlyph}</span>
        <span><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="none" stroke="#f4f4fa" strokeWidth="1.3" strokeDasharray="2 1.6" /></svg>{text.robustGlyph}</span>
      </span>
      <span className="pt-spacer" />
      <span className="meth">{fill(text.method, { h: FIELD_H })}{colorBy === "calmar" ? fill(text.methodContour, { i: contourInterval(vmin, vmax) }) : ""}</span>
    </div>
  );
}

const ICON_BASE = <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
const ICON_BEST = <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .5L9.5 5 5 9.5.5 5z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
const ICON_ROB = <svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.8 1.4" /></svg>;
const ICON_WARN = <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3.2M8 11.7v.1" strokeLinecap="round" /></svg>;

function gradeText(text: Copy, nb: TerrainNeighbors) {
  return nb.grade === "robust" ? text.gradeRobust : nb.grade === "fair" ? text.gradeFair : nb.grade === "fragile" ? text.gradeFragile : "—";
}

function SidePanel({ text, c, st, D, params, allParams, axisX, axisY, vmin, vmax, trainDays, valDays }: Readonly<{
  text: Copy; c: TerrainCandidate; st: TerrainStatus; D: TerrainDerived; params: TerrainParam[]; allParams: TerrainParam[]; axisX: number; axisY: number; vmin: number; vmax: number; trainDays: number; valDays: number;
}>) {
  const doneOk = st === "completed";
  const nb = doneOk && c.validationCalmar != null ? D.neighbors(c) : null;
  const g = D.gap.get(c.index);
  const rank = D.rank.get(c.index);
  const base = D.base;
  const baseCompleted = Boolean(base && base.validationCalmar != null && D.valid.includes(base));
  const dBase = doneOk && c.validationCalmar != null && baseCompleted && c.index !== 0 && base ? c.validationCalmar - (base.validationCalmar as number) : null;
  const tags: ReactNode[] = [];
  if (c.index === 0) tags.push(<span className="pt-mk" key="b">{ICON_BASE}{text.baselineGlyph}</span>);
  if (D.best === c) tags.push(<span className="pt-mk" key="best">{ICON_BEST}{text.bestGlyph}</span>);
  if (D.robust === c) tags.push(<span className="pt-mk" key="rob">{ICON_ROB}{text.robustGlyph}</span>);
  if (st === "running") tags.push(<span className="pt-mk live" key="run"><span className="pt-live" />{text.statusRunning}</span>);
  if (st === "queued") tags.push(<span className="pt-mk" key="q">{text.statusQueued}</span>);
  if (st === "failed") tags.push(<span className="pt-mk warn" key="f">{text.statusFailed}</span>);
  if (st === "cancelled") tags.push(<span className="pt-mk" key="c">{text.statusCancelled}</span>);
  if (nb && nb.grade === "fragile") tags.push(<span className="pt-mk warn" key="fr">{text.tagFragile}</span>);
  if (g != null && g > GAP_HI) tags.push(<span className="pt-mk warn" key="gh">{text.tagGapHigh}</span>);
  const unscored = doneOk && c.validationCalmar == null ? (c.validationCalmarReason === "noDrawdown" ? text.flatScored : text.notScored) : "";

  const tm = c.trainMetrics, vm = c.validationMetrics;
  const gw = g == null ? 0 : clamp(g / GMAX, 0, 1) * 100;
  return (
    <>
      <section className="pt-sec">
        <div className="pt-cd-head"><span className="id">#{c.index}</span>{tags}
          <span className="rank">{rank ? <>{text.rank} <b>{rank}</b> / {D.valid.length}</> : null}</span></div>
        <div className="pt-cd-big"><span className="pt-display" data-testid="terrain-selected-calmar">{doneOk ? fmtC(c.validationCalmar) : "—"}</span>
          <span className="u">{text.validationCalmar}{unscored ? ` · ${unscored}` : ""}{st === "failed" && c.error ? ` · ${c.error}` : ""}</span>
          {dBase != null ? <span className="d">{text.vsBaseline} {dBase >= 0 ? "+" : "−"}{Math.abs(dBase).toFixed(2)}</span> : null}</div>
      </section>

      {nb && nb.list.length ? (() => {
        const lo = Math.min(vmin, nb.worst), hi = Math.max(vmax, c.validationCalmar as number);
        const pos = (v: number) => ((v - lo) / (hi - lo)) * 100;
        const dropCls = nb.grade === "fragile" ? "warn" : nb.grade === "robust" ? "ok" : "";
        return (
          <section className="pt-sec">
            <div className="pt-sec-h"><span className="pt-micro">{text.robustness}</span><small title={text.nbHint}>{fill(text.nbCount, { n: nb.list.length, r: nb.radius.toFixed(2) })}{nb.widened ? text.widened : ""}</small></div>
            <div className="pt-rob">
              <div className="pt-rob-grid">
                <div><span>{text.nbMedian}</span><b className="pt-num">{fmtC(nb.med)}</b></div>
                <div><span>{text.vsSelf}</span><b className={clsx("pt-num", dropCls)}>{nb.dropPct == null ? "—" : `${nb.dropPct > 0 ? "−" : "+"}${Math.abs(nb.dropPct * 100).toFixed(0)}%`}</b></div>
                <div><span>{text.grade}</span><b className={dropCls}>{gradeText(text, nb)}</b></div>
              </div>
              <div>
                <div className="pt-rob-line">
                  <span className="ax" />
                  <span className="band" style={{ left: `${pos(nb.worst)}%`, width: `${Math.max(0.8, pos(nb.best) - pos(nb.worst))}%` }} />
                  {nb.list.map((o) => <span key={o.c.index} className="nb" style={{ left: `${pos(o.c.validationCalmar as number)}%` }} title={`#${o.c.index} · ${fmtC(o.c.validationCalmar)} · ${o.d.toFixed(2)}`} />)}
                  <span className="md" style={{ left: `${pos(nb.med)}%` }} />
                  <span className="me" style={{ left: `${pos(c.validationCalmar as number)}%` }} />
                </div>
                <div className="pt-rob-cap"><span>{fmtC(lo, 1)}</span><span>{text.robCap}</span><span>{fmtC(hi, 1)}</span></div>
              </div>
            </div>
          </section>
        );
      })() : null}

      {doneOk && tm && vm ? (
        <section className="pt-sec">
          <div className="pt-sec-h"><span className="pt-micro">{text.trainVsVal}</span><small>train / validation_metrics_json</small></div>
          <table className="pt-mt">
            <thead><tr><th /><th>{text.train}<small>{fill(text.trainSub, { d: trainDays })}</small></th><th>{text.validation}<small>{fill(text.valSub, { d: valDays })}</small></th></tr></thead>
            <tbody>
              <tr className="hl"><td>Calmar</td><td className="tr pt-num">{fmtC(c.trainCalmar)}</td><td className="pt-num">{fmtC(c.validationCalmar)}</td></tr>
              <tr><td>{text.rowReturn}</td><td className="tr pt-num">{fmtPct(tm.netReturnPct)}</td><td className="pt-num">{fmtPct(vm.netReturnPct)}</td></tr>
              <tr><td>{text.rowDd}</td><td className="tr pt-num">{fmtPct(tm.maxDrawdownPct, false)}</td><td className="pt-num">{fmtPct(vm.maxDrawdownPct, false)}</td></tr>
              <tr><td>{text.rowTrades}</td><td className="tr pt-num">{tm.closedTradeCount}</td><td className="pt-num">{vm.closedTradeCount}</td></tr>
              <tr><td>{text.rowWin}</td><td className="tr pt-num">{tm.winRate == null ? "—" : `${(tm.winRate * 100).toFixed(1)}%`}</td><td className="pt-num">{vm.winRate == null ? "—" : `${(vm.winRate * 100).toFixed(1)}%`}</td></tr>
              <tr><td>{text.rowSharpe}</td><td className="tr pt-num">{fmtC(tm.annualizedSharpe)}</td><td className="pt-num">{fmtC(vm.annualizedSharpe)}</td></tr>
            </tbody>
          </table>
          {g != null ? (
            <div className={clsx("pt-gapline", g > GAP_HI && "is-high")} title={text.gapHint}>
              <span>{text.gapRow}</span><span className="gb"><i style={{ width: `${gw}%` }} /><em style={{ left: `${(GAP_HI / GMAX) * 100}%` }} /></span><b>{fmtC(g, 1)}</b>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="pt-sec">
        <div className="pt-sec-h"><span className="pt-micro">{text.paramsSec}</span><small>parameters_json</small></div>
        <table className="pt-pt">
          <thead><tr><th>{text.paramName}</th><th className="r">{text.thisCandidate}</th><th className="r">{text.baseline}</th><th className="r">{text.deltaCol}</th></tr></thead>
          <tbody>
            {params.map((p) => {
              const d = allParams.indexOf(p);
              const v = c.params[p.key], b = p.base, dd = v - b;
              const ax = d === axisX ? "X" : d === axisY ? "Y" : "";
              return (
                <tr key={p.key} className={ax ? "is-axis" : ""}>
                  <td className="k" title={fill(text.rangeHint, { min: formatParam(p, p.min), max: formatParam(p, p.max), step: formatParam(p, p.step) })}><code data-ax={ax}>{p.key}</code></td>
                  <td className="r v pt-num">{formatParam(p, v)}</td>
                  <td className="r b pt-num">{formatParam(p, b)}</td>
                  <td className={clsx("r dl pt-num", Math.abs(dd) > 1e-9 && "nz")}>{Math.abs(dd) < 1e-9 ? "·" : `${dd > 0 ? "+" : "−"}${formatParam(p, Math.abs(dd))}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="pt-sec">
        <div className="pt-sec-h"><span className="pt-micro">{text.sensSec}</span><small>{text.sensHint}</small></div>
        <div className="pt-sens">
          {params.map((p) => <SensitivityRow key={p.key} text={text} D={D} params={allParams} d={allParams.indexOf(p)} c={c} vmin={vmin} vmax={vmax} />)}
        </div>
      </section>
    </>
  );
}

function SensitivityRow({ text, D, params, d, c, vmin, vmax }: Readonly<{ text: Copy; D: TerrainDerived; params: TerrainParam[]; d: number; c: TerrainCandidate; vmin: number; vmax: number }>) {
  const p = params[d];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const model = useMemo(() => sensitivityModel(D, params, d, c), [D, params, d, c]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = () => {
      const fit = fitCanvas(canvas);
      if (!fit) return;
      const { ctx, w, h } = fit;
      ctx.clearRect(0, 0, w, h);
      const padL = 2, padR = 2, padT = 4, padB = 4;
      const xs = (v: number) => padL + nu(p, v) * (w - padL - padR);
      const ys = (v: number) => padT + (1 - (v - vmin) / (vmax - vmin)) * (h - padT - padB);
      ctx.fillStyle = "rgba(200,200,230,0.035)";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(200,200,230,0.14)"; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Math.round(ys(0)) + 0.5); ctx.lineTo(w, Math.round(ys(0)) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      model.pts.forEach(({ o, wo }) => {
        ctx.fillStyle = `rgba(185,186,203,${0.08 + 0.72 * (wo / model.maxW)})`;
        ctx.beginPath(); ctx.arc(xs(o.params[p.key]), ys(o.validationCalmar as number), 1.8, 0, Math.PI * 2); ctx.fill();
      });
      ctx.strokeStyle = "rgba(106,176,236,0.95)"; ctx.lineWidth = 1.5;
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k <= 60; k += 1) {
        const v = p.min + ((p.max - p.min) * k) / 60, yv = model.curve(v);
        if (yv == null) { pen = false; continue; }
        if (!pen) ctx.moveTo(xs(v), ys(yv)); else ctx.lineTo(xs(v), ys(yv));
        pen = true;
      }
      ctx.stroke();
      ctx.fillStyle = "rgba(126,128,150,1)";
      ctx.fillRect(xs(p.base) - 2.5, h - 5, 5, 5);
      const sv = c.params[p.key];
      ctx.strokeStyle = "rgba(244,244,250,0.85)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(xs(sv)) + 0.5, 0); ctx.lineTo(Math.round(xs(sv)) + 0.5, h); ctx.stroke();
    };
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [c, model, p, vmax, vmin]);
  const read = model.y0 != null ? fill(text.sensRead, { a: fmtC(model.worst1), b: fmtC(model.worst2) }) : text.sensNone;
  return (
    <div className="pt-sens-row">
      <div className="l"><code>{p.key}</code><span className="v">{formatParam(p, c.params[p.key])}</span><span className={clsx("dd", model.worst2 != null && model.worst2 < -0.5 && "warn")}>{read}</span></div>
      <canvas ref={canvasRef} />
      <div className="rng pt-num"><span>{formatParam(p, p.min)}</span><span>{formatParam(p, p.max)}</span></div>
    </div>
  );
}

function Actions({ text, c, st, D, applying, onSelect, onApply, onBacktest }: Readonly<{
  text: Copy; c: TerrainCandidate | null; st: TerrainStatus | null; D: TerrainDerived; applying: boolean;
  onSelect: (index: number) => void; onApply: () => void; onBacktest: () => void;
}>) {
  const doneOk = Boolean(c && st === "completed" && c.validationCalmar != null);
  const nb = c && doneOk ? D.neighbors(c) : null;
  const g = c ? D.gap.get(c.index) : undefined;
  const fragile = nb?.grade === "fragile";
  const gapHi = g != null && g > GAP_HI;
  let note: ReactNode = null;
  if (c && doneOk && (fragile || gapHi)) {
    const why: string[] = [];
    if (fragile && nb) why.push(fill(text.warnFragile, { m: fmtC(nb.med), p: ((nb.dropPct ?? 0) * 100).toFixed(0) }));
    if (gapHi) why.push(fill(text.warnGap, { g: fmtC(g, 1) }));
    const alt = D.robust && D.robust !== c ? D.robust : null;
    note = (
      <div className="pt-warnbox">{ICON_WARN}<div>{why.join(text.warnJoin)}{text.warnTail}{alt ? <> <button type="button" onClick={() => onSelect(alt.index)}>{fill(text.viewRobust, { i: alt.index })}</button></> : null}</div></div>
    );
  } else if (doneOk && nb && nb.list.length) {
    note = <div className="pt-okbox">{fill(text.okNote, { n: nb.list.length, m: fmtC(nb.med) })}</div>;
  } else if (st === "running" || st === "queued") {
    note = <div className="pt-okbox">{text.pendingNote}</div>;
  }
  return (
    <div className="pt-act">
      {note}
      <div className="btns">
        <button className="pt-btn pt-btn-primary" type="button" disabled={!doneOk || applying} onClick={onApply} data-testid="terrain-apply">{applying ? text.saving : text.apply}</button>
        <button className="pt-btn" type="button" disabled={!doneOk || applying} onClick={onBacktest}>{text.backtest}</button>
      </div>
      <div className="fine">{text.fine}</div>
    </div>
  );
}

/** Labels the tuning workbench needs to link back to the terrain. */
export function parameterTerrainLabels(chinese: boolean) {
  return chinese
    ? { viewTerrain: "查看参数地形图", terrainHint: "调优结果以参数地形图展示：比较稳健平台与过拟合尖峰后再应用参数。" }
    : { viewTerrain: "View parameter terrain", terrainHint: "Results open in the parameter terrain: compare stable plateaus with overfit spikes before applying parameters." };
}
