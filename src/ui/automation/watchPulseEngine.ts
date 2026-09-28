/*
 * 值守心电图 —— Canvas 引擎（移植自 viz/prototypes/watch-pulse.html）。
 *
 * 三层画布：
 * - base：网格、刻度、基线、脉冲与动作标记（视图变化或每 5 秒重画）；
 * - live：现在线、运行中脉冲（唯一发光、唯一动画）、下次唤醒、悬停与选中；
 * - ov：7 天总览与刷选框。
 * DOM 部分（泳道标签、摘要、提示、抽屉）由 React 渲染，引擎通过回调通知。
 */
import {
  DAY,
  HOUR,
  MIN,
  deepTokens,
  fHM,
  fHMS,
  fMD,
  fStamp,
  isDeep,
  isFailedRun,
  laneWake,
  pad,
  pulseText,
  sameDay,
  weekdayLabel,
  type ActionKey,
  type PulseRun,
  type WatchPulseProfile
} from "./watchPulseModel";

export type PulseWindow = "24h" | "7d";
export const WINDOWS: Record<PulseWindow, { span: number; fut: number }> = {
  "24h": { span: DAY, fut: 0.075 },
  "7d": { span: 7 * DAY, fut: 0.05 }
};

export const AXIS_H = 26;
const PAD_L = 12;
const PAD_R = 16;
const STEPS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
const ACTS: ActionKey[] = ["trade", "opportunity", "notification", "wake"];

export type LaneGeom = { top: number; h: number; base: number; maxH: number };
type Geom = { x0: number; x1: number; h: number; deep: boolean; failed: boolean; running: boolean };
type RunHit = { r: PulseRun; lane: number; x0: number; x1: number; top: number; bot: number; pri: number };
type WakeHit = { lane: number; x: number; y: number; target: number; w?: number; off?: boolean };

export type PulseHover =
  | { kind: "run"; run: PulseRun; lane: number; ax: number; ay: number }
  | { kind: "wake"; lane: number; target: number; ax: number; ay: number };

export type PulseViewState = {
  t0: number;
  t1: number;
  follow: boolean;
  win: PulseWindow;
  /** 与某个预设窗口完全一致且跟随现在时，对应的分段按钮高亮。 */
  pressed: PulseWindow | null;
  showSkips: boolean;
  atNow: boolean;
};

export type PulseCallbacks = {
  onView: (view: PulseViewState) => void;
  onLayout: (lanes: LaneGeom[], size: { w: number; h: number }) => void;
  onHover: (hover: PulseHover | null) => void;
  onSelect: (run: PulseRun | null) => void;
  onLaneHover: (lane: number) => void;
  onSecond: () => void;
};

type Palette = {
  ai: string; aiHi: string; aiFillTop: string; aiFillBot: string; aiDashFill: string;
  skip: string; skipOv: string; warn: string; warnFill: string;
  ink: string; ink2: string; ink3: string; ink4: string;
  hair: string; hair2: string; hair3: string; grid: string; fut: string;
  s2: string; s3: string; bg: string; ring: string;
  rgb: Record<string, [number, number, number]>;
  fontNum: string;
};

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

function fitCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 梯形脉冲：陡升 → 平台（宽 = 实际耗时）→ 陡降；off > 0 时画外框。 */
function tracePulse(ctx: CanvasRenderingContext2D, x0: number, x1: number, base: number, h: number, off: number) {
  const s = Math.min((x1 - x0) * 0.2, 2.5);
  ctx.beginPath();
  ctx.moveTo(x0 - off, base);
  ctx.lineTo(x0 + s - off * 0.4, base - h - off);
  ctx.lineTo(x1 - s + off * 0.4, base - h - off);
  ctx.lineTo(x1 + off, base);
}

export class WatchPulseEngine {
  private root: HTMLElement;
  private plot: HTMLElement;
  private baseC: HTMLCanvasElement;
  private liveC: HTMLCanvasElement;
  private ovC: HTMLCanvasElement;
  private cb: PulseCallbacks;
  private now: () => number;

  private profiles: WatchPulseProfile[] = [];
  private byLane: PulseRun[][] = [];
  private deepMax = 2e5;
  private dataStart = 0;
  private hasRunning = false;

  private bctx: CanvasRenderingContext2D | null = null;
  private lctx: CanvasRenderingContext2D | null = null;
  private octx: CanvasRenderingContext2D | null = null;
  private G = { w: 0, h: 0, lanes: [] as LaneGeom[] };
  private OG = { w: 0, h: 0 };
  private K: Palette | null = null;

  private S = {
    win: "24h" as PulseWindow,
    t0: 0,
    t1: 0,
    follow: true,
    showSkips: true,
    hover: null as RunHit | null,
    sel: null as PulseRun | null,
    mouse: null as { x: number; y: number } | null,
    drag: null as { x: number; t0: number; t1: number; moved: boolean } | null
  };
  private hitList: RunHit[] = [];
  private wakeHits: WakeHit[] = [];
  private numBoxes: { x0: number; x1: number; y: number }[] = [];
  private baseDirty = true;
  private liveDirty = true;
  private lastBase = 0;
  private lastSec = 0;
  private raf = 0;
  private disposed = false;
  private rmq: MediaQueryList;
  private observers: ResizeObserver[] = [];
  private themeObserver: MutationObserver | null = null;
  private brush = { mode: null as null | "l" | "r" | "m", grabT: 0, a0: 0, a1: 0 };
  private cleanups: (() => void)[] = [];

  constructor(opts: {
    root: HTMLElement;
    plot: HTMLElement;
    base: HTMLCanvasElement;
    live: HTMLCanvasElement;
    ov: HTMLCanvasElement;
    ovBox: HTMLElement;
    now: () => number;
    callbacks: PulseCallbacks;
  }) {
    this.root = opts.root;
    this.plot = opts.plot;
    this.baseC = opts.base;
    this.liveC = opts.live;
    this.ovC = opts.ov;
    this.now = opts.now;
    this.cb = opts.callbacks;
    this.rmq = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.readPalette();
    this.bindPlot();
    this.bindBrush();
    const plotObserver = new ResizeObserver(() => this.resize());
    plotObserver.observe(this.plot);
    const ovObserver = new ResizeObserver(() => { this.layoutOv(); this.drawOv(); });
    ovObserver.observe(opts.ovBox);
    this.observers.push(plotObserver, ovObserver);
    // 外观切换（磷光 / 经典）时重新取色。
    this.themeObserver = new MutationObserver(() => { this.readPalette(); this.baseDirty = true; this.liveDirty = true; });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-visual", "class", "style"] });
    this.layout();
    this.layoutOv();
    this.setWindow("24h");
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observers.forEach((observer) => observer.disconnect());
    this.themeObserver?.disconnect();
    this.cleanups.forEach((fn) => fn());
  }

  private get RM() {
    return this.rmq.matches;
  }

  // ============================================================
  // 数据
  // ============================================================
  setData(profiles: WatchPulseProfile[], byLane: PulseRun[][], deepMax: number, dataStart: number) {
    const lanesChanged = profiles.length !== this.profiles.length || profiles.some((p, i) => p.id !== this.profiles[i]?.id);
    this.profiles = profiles;
    this.byLane = byLane;
    this.deepMax = deepMax;
    this.dataStart = dataStart;
    this.hasRunning = byLane.some((runs) => runs.some((run) => run.status === "running"));
    if (this.S.sel) {
      const fresh = byLane.flat().find((run) => run.id === this.S.sel!.id);
      if (fresh) this.S.sel = fresh;
    }
    if (lanesChanged) this.layout();
    this.baseDirty = true;
    this.liveDirty = true;
    this.emitView();
  }

  setSelected(run: PulseRun | null) {
    this.S.sel = run;
    this.liveDirty = true;
    if (run && (run.startedAt < this.S.t0 || (run.finishedAt ?? this.now()) > this.S.t1)) {
      const span = this.S.t1 - this.S.t0;
      this.setView(run.startedAt - span * 0.6, run.startedAt + span * 0.4);
    }
  }

  getView() {
    return { t0: this.S.t0, t1: this.S.t1 };
  }

  domain() {
    return { d0: this.dataStart - HOUR, d1: this.now() + 12 * HOUR };
  }

  // ============================================================
  // 视图
  // ============================================================
  setWindow(w: PulseWindow) {
    this.S.win = w;
    const { span, fut } = WINDOWS[w];
    const n = this.now();
    this.S.t1 = n + span * fut;
    this.S.t0 = n - span;
    this.S.follow = true;
    this.viewChanged();
  }

  resetWindow() {
    this.setWindow(this.S.win);
  }

  setView(t0: number, t1: number, keepFollow = false) {
    const { d0, d1 } = this.domain();
    const span = clamp(t1 - t0, 20 * MIN, d1 - d0);
    t0 = clamp(t0, d0, d1 - span);
    this.S.t0 = t0;
    this.S.t1 = t0 + span;
    const n = this.now();
    if (!keepFollow) this.S.follow = this.S.t1 >= n + 60_000 && this.S.t0 < n;
    this.viewChanged();
  }

  toggleSkips() {
    this.S.showSkips = !this.S.showSkips;
    this.viewChanged();
  }

  goNow() {
    const span = this.S.t1 - this.S.t0;
    const w = WINDOWS[this.S.win];
    const fut = w.fut / (1 + w.fut);
    const n = this.now();
    this.setView(n - span * (1 - fut), n + span * fut);
    this.S.follow = true;
    this.viewChanged();
  }

  private pressedWindow(): PulseWindow | null {
    const span = this.S.t1 - this.S.t0;
    const matched = (Object.keys(WINDOWS) as PulseWindow[]).find((key) => Math.abs(span - WINDOWS[key].span * (1 + WINDOWS[key].fut)) < 60_000);
    return matched && this.S.follow ? matched : null;
  }

  private emitView() {
    this.cb.onView({
      t0: this.S.t0,
      t1: this.S.t1,
      follow: this.S.follow,
      win: this.S.win,
      pressed: this.pressedWindow(),
      showSkips: this.S.showSkips,
      atNow: this.S.t1 >= this.now()
    });
  }

  private viewChanged() {
    this.baseDirty = true;
    this.liveDirty = true;
    this.emitView();
    if (this.S.hover) {
      this.S.hover = null;
      this.cb.onHover(null);
    }
  }

  // ============================================================
  // 颜色（从作用域 CSS 变量解析成 rgb，canvas 统一用 rgba）
  // ============================================================
  private readPalette() {
    const probeEl = document.createElement("span");
    probeEl.style.position = "absolute";
    probeEl.style.visibility = "hidden";
    this.root.appendChild(probeEl);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const probe = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgbOf = (cssVar: string, fallback: string): [number, number, number] => {
      probeEl.style.color = fallback;
      probeEl.style.color = `var(${cssVar}, ${fallback})`;
      const resolved = getComputedStyle(probeEl).color || fallback;
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = "#000";
      probe.fillStyle = resolved;
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const rgb = {
      bg: rgbOf("--wp-bg", "#05060b"),
      s2: rgbOf("--wp-s2", "#10111a"),
      s3: rgbOf("--wp-s3", "#171824"),
      ink: rgbOf("--wp-ink", "#f4f4fa"),
      ink2: rgbOf("--wp-ink-2", "#b9bacb"),
      ink3: rgbOf("--wp-ink-3", "#7e8096"),
      ink4: rgbOf("--wp-ink-4", "#53556a"),
      ai: rgbOf("--wp-ai", "#9a63ff"),
      aiHi: rgbOf("--wp-ai-hi", "#c3a5ff"),
      warn: rgbOf("--wp-warn", "#f3b23c")
    };
    const fontNum = getComputedStyle(this.root).getPropertyValue("--wp-font-num").trim() || "ui-monospace, Menlo, monospace";
    probeEl.remove();
    const A = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    this.K = {
      ai: A(rgb.ai, 1), aiHi: A(rgb.aiHi, 1), aiFillTop: A(rgb.ai, 0.34), aiFillBot: A(rgb.ai, 0.05), aiDashFill: A(rgb.ai, 0.12),
      skip: A(rgb.ink3, 0.55), skipOv: A(rgb.ink3, 0.28), warn: A(rgb.warn, 1), warnFill: A(rgb.warn, 0.22),
      ink: A(rgb.ink, 1), ink2: A(rgb.ink2, 1), ink3: A(rgb.ink3, 1), ink4: A(rgb.ink4, 1),
      hair: A(rgb.ink, 0.06), hair2: A(rgb.ink, 0.1), hair3: A(rgb.ink, 0.18), grid: A(rgb.ink, 0.035),
      fut: A(rgb.ink, 0.022), s2: A(rgb.s2, 1), s3: A(rgb.s3, 1), bg: A(rgb.bg, 1), ring: A(rgb.ink2, 0.85),
      rgb,
      fontNum
    };
  }

  private A(key: keyof Palette["rgb"], a: number) {
    const c = this.K!.rgb[key];
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  }

  // ============================================================
  // 几何
  // ============================================================
  private layout() {
    const b = fitCanvas(this.baseC);
    this.bctx = b.ctx;
    const l = fitCanvas(this.liveC);
    this.lctx = l.ctx;
    this.G.w = b.w;
    this.G.h = b.h;
    const count = Math.max(1, this.profiles.length);
    const avail = this.G.h - AXIS_H;
    const lh = avail / count;
    this.G.lanes = this.profiles.map((_, i) => {
      const top = AXIS_H + i * lh;
      const base = Math.round(top + lh - Math.max(20, lh * 0.17)) + 0.5;
      const maxH = Math.max(24, Math.min(120, base - top - 34));
      return { top, h: lh, base, maxH };
    });
    this.cb.onLayout(this.G.lanes, { w: this.G.w, h: this.G.h });
  }

  private layoutOv() {
    const f = fitCanvas(this.ovC);
    this.octx = f.ctx;
    this.OG.w = f.w;
    this.OG.h = f.h;
  }

  private resize() {
    if (this.disposed) return;
    this.layout();
    this.layoutOv();
    this.drawBase();
    this.drawOv();
    this.drawLive(performance.now());
  }

  xOf = (t: number) => PAD_L + ((t - this.S.t0) / (this.S.t1 - this.S.t0)) * (this.G.w - PAD_L - PAD_R);
  tOf = (x: number) => this.S.t0 + ((x - PAD_L) / (this.G.w - PAD_L - PAD_R)) * (this.S.t1 - this.S.t0);
  private pxPerHour() {
    return (this.G.w - PAD_L - PAD_R) / ((this.S.t1 - this.S.t0) / HOUR);
  }

  pulseGeom(r: PulseRun, lane: LaneGeom): Geom {
    const x0 = this.xOf(r.startedAt);
    const end = r.finishedAt ?? this.now();
    const x1 = this.xOf(end);
    const deep = isDeep(r);
    const failed = isFailedRun(r);
    const running = r.status === "running";
    let h: number;
    if (failed) h = 0;
    else if (running) h = lane.maxH * 0.52;
    else if (deep) h = Math.max(14, lane.maxH * Math.sqrt(clamp((deepTokens(r) || 0) / this.deepMax, 0, 1)));
    else h = 5;
    const pxh = this.pxPerHour();
    const minW = deep || failed || running ? (pxh >= 20 ? 6 : 3) : (pxh >= 20 ? 2 : 1.2);
    if (x1 - x0 < minW) {
      const c = (x0 + x1) / 2;
      return { x0: c - minW / 2, x1: c + minW / 2, h, deep, failed, running };
    }
    return { x0, x1, h, deep, failed, running };
  }

  /** 悬停提示与 smoke 需要的脉冲锚点（plot 坐标）。 */
  anchorOf(run: PulseRun) {
    const lane = this.laneIndexOf(run);
    if (lane < 0) return null;
    const L = this.G.lanes[lane];
    const g = this.pulseGeom(run, L);
    return { x: (g.x0 + g.x1) / 2, y: L.base - Math.max(g.h, 4) / 2, top: L.base - g.h - 12, lane };
  }

  private laneIndexOf(run: PulseRun) {
    return this.profiles.findIndex((p) => p.id === run.profileId);
  }

  // ============================================================
  // 刻度
  // ============================================================
  private ticks() {
    const pxh = this.pxPerHour();
    const step = STEPS.find((s) => (s / HOUR) * pxh >= 64) || DAY;
    const tz = new Date(this.S.t0).getTimezoneOffset() * MIN;
    const out: { t: number; day: boolean }[] = [];
    for (let t = Math.ceil((this.S.t0 - tz) / step) * step + tz; t <= this.S.t1; t += step) {
      const d = new Date(t);
      out.push({ t, day: d.getHours() === 0 && d.getMinutes() === 0 });
    }
    return { out, step };
  }

  // ============================================================
  // 静态层
  // ============================================================
  private drawBase() {
    const ctx = this.bctx;
    const K = this.K;
    if (!ctx || !K) return;
    const { w: W, h: H } = this.G;
    this.numBoxes = [];
    ctx.clearRect(0, 0, W, H);
    ctx.font = `10.5px ${K.fontNum}`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    const n = this.now();
    const xn = this.xOf(n);

    // 未来区
    if (xn < W) {
      ctx.fillStyle = K.fut;
      ctx.fillRect(Math.max(0, xn), AXIS_H, W - Math.max(0, xn), H - AXIS_H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(0, xn), AXIS_H, W, H - AXIS_H);
      ctx.clip();
      ctx.strokeStyle = K.grid;
      for (let x = Math.max(0, xn) - H; x < W; x += 7) {
        ctx.beginPath();
        ctx.moveTo(x, H);
        ctx.lineTo(x + H, 0);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 刻度 + 网格
    const { out, step } = this.ticks();
    ctx.textAlign = "center";
    for (const k of out) {
      const nearNow = Math.abs(this.xOf(k.t) - xn) < 62;
      const x = Math.round(this.xOf(k.t)) + 0.5;
      ctx.strokeStyle = k.day ? K.hair2 : K.grid;
      ctx.beginPath(); ctx.moveTo(x, AXIS_H); ctx.lineTo(x, H); ctx.stroke();
      ctx.strokeStyle = K.hair2;
      ctx.beginPath(); ctx.moveTo(x, AXIS_H - 4); ctx.lineTo(x, AXIS_H); ctx.stroke();
      const d = new Date(k.t);
      const lbl = k.day || step >= DAY ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${weekdayLabel(k.t)}` : fHM(k.t);
      ctx.fillStyle = k.day ? K.ink2 : K.ink3;
      if (!nearNow) ctx.fillText(lbl, x, AXIS_H / 2);
    }
    ctx.strokeStyle = K.hair2;
    ctx.beginPath(); ctx.moveTo(0, AXIS_H + 0.5); ctx.lineTo(W, AXIS_H + 0.5); ctx.stroke();

    this.hitList = [];
    const pxh = this.pxPerHour();
    this.G.lanes.forEach((L, i) => {
      ctx.strokeStyle = K.hair;
      const yb = Math.round(L.top + L.h) - 0.5;
      ctx.beginPath(); ctx.moveTo(0, yb); ctx.lineTo(W, yb); ctx.stroke();
      // 基线：历史实线，未来虚线（在 live 层画）
      ctx.strokeStyle = K.hair3;
      ctx.beginPath(); ctx.moveTo(0, L.base); ctx.lineTo(Math.min(W, xn), L.base); ctx.stroke();

      const runs = this.byLane[i] ?? [];
      const vis = runs.filter((r) => (r.finishedAt ?? n) >= this.S.t0 - 2 * MIN && r.startedAt <= this.S.t1);
      // 先画跳过，再画深度，最后失败，保证重要的在上层
      if (this.S.showSkips) {
        ctx.fillStyle = K.skip;
        for (const r of vis) {
          if (isDeep(r) || isFailedRun(r) || r.status === "running") continue;
          const g = this.pulseGeom(r, L);
          ctx.fillRect(g.x0, L.base - g.h, g.x1 - g.x0, g.h);
          this.hitList.push({ r, lane: i, x0: g.x0, x1: g.x1, top: L.base - 12, bot: L.base + 4, pri: 0 });
        }
      }
      for (const r of vis) {
        if (!isDeep(r) || isFailedRun(r) || r.status === "running") continue;
        const g = this.pulseGeom(r, L);
        tracePulse(ctx, g.x0, g.x1, L.base, g.h, 0);
        const grad = ctx.createLinearGradient(0, L.base - g.h, 0, L.base);
        const sampled = r.triage?.sampled;
        grad.addColorStop(0, sampled ? K.aiDashFill : K.aiFillTop);
        grad.addColorStop(1, K.aiFillBot);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = K.aiHi;
        ctx.lineWidth = 1;
        if (sampled) ctx.setLineDash([3, 2.5]);
        ctx.stroke();
        ctx.setLineDash([]);
        const forced = Boolean(r.triage?.forcedBy?.length);
        if (forced) {
          tracePulse(ctx, g.x0, g.x1, L.base, g.h, 3);
          ctx.strokeStyle = K.ring;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        this.drawActions(ctx, r, (g.x0 + g.x1) / 2, L.base - g.h - (forced ? 9 : 6), pxh);
        this.hitList.push({ r, lane: i, x0: g.x0, x1: g.x1, top: L.base - g.h - 16, bot: L.base + 4, pri: 1 });
      }
      for (const r of vis) {
        if (!isFailedRun(r)) continue;
        const g = this.pulseGeom(r, L);
        const c = (g.x0 + g.x1) / 2;
        const hw = Math.max(4.5, (g.x1 - g.x0) / 2);
        ctx.beginPath();
        ctx.moveTo(c - hw, L.base); ctx.lineTo(c, L.base + 11); ctx.lineTo(c + hw, L.base); ctx.closePath();
        ctx.fillStyle = K.warnFill;
        ctx.fill();
        ctx.strokeStyle = K.warn;
        ctx.lineWidth = 1.3;
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.lineWidth = 1;
        this.hitList.push({ r, lane: i, x0: c - hw, x1: c + hw, top: L.base - 6, bot: L.base + 14, pri: 2 });
      }
    });
  }

  // 动作标记：自下而上堆叠 ▲交易 ◆机会 ●通知 □观察计划
  private glyph(ctx: CanvasRenderingContext2D, k: ActionKey, x: number, y: number, s: number) {
    const K = this.K!;
    ctx.beginPath();
    if (k === "trade") { ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s * 0.8); ctx.lineTo(x - s, y + s * 0.8); ctx.closePath(); ctx.fillStyle = K.ink; ctx.fill(); }
    else if (k === "opportunity") { ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); ctx.fillStyle = K.ink2; ctx.fill(); }
    else if (k === "notification") { ctx.arc(x, y, s * 0.72, 0, Math.PI * 2); ctx.fillStyle = K.ink3; ctx.fill(); }
    else { ctx.rect(x - s * 0.7 + 0.5, y - s * 0.7 + 0.5, s * 1.4 - 1, s * 1.4 - 1); ctx.strokeStyle = K.ink3; ctx.lineWidth = 1; ctx.stroke(); }
  }

  private drawActions(ctx: CanvasRenderingContext2D, r: PulseRun, x: number, y: number, pxh: number) {
    const K = this.K!;
    const ac = r.actionCounts;
    const s = pxh > 20 ? 3.4 : 2.8;
    const gap = s * 2 + 3;
    let yy = y - s;
    const showN = pxh >= 30;
    ctx.font = `9.5px ${K.fontNum}`;
    ctx.textAlign = "left";
    for (const k of ACTS) {
      const c = ac[k] || 0;
      if (!c) continue;
      this.glyph(ctx, k, x, yy, s);
      if (showN && c > 1) {
        const lx = x + s + 2.5;
        const tw = ctx.measureText(`×${c}`).width;
        const free = !this.numBoxes.some((b) => lx < b.x1 + 3 && lx + tw > b.x0 - 3 && Math.abs(yy - b.y) < 10);
        if (free) {
          ctx.fillStyle = K.ink3;
          ctx.fillText(`×${c}`, lx, yy + 0.5);
          this.numBoxes.push({ x0: lx, x1: lx + tw, y: yy });
        }
      }
      yy -= gap;
    }
  }

  // ============================================================
  // 动态层
  // ============================================================
  private drawLive(ts: number) {
    const ctx = this.lctx;
    const K = this.K;
    if (!ctx || !K) return;
    const { w: W, h: H } = this.G;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    const n = this.now();
    const xn = this.xOf(n);
    this.wakeHits = [];

    // 选中：竖向引导 + 描边
    if (this.S.sel) {
      const i = this.laneIndexOf(this.S.sel);
      const L = this.G.lanes[i];
      if (L) {
        const g = this.pulseGeom(this.S.sel, L);
        ctx.fillStyle = K.hair;
        ctx.fillRect(g.x0 - 2, AXIS_H + 1, g.x1 - g.x0 + 4, H - AXIS_H);
        this.outlineRun(ctx, this.S.sel, L, g, K.ink, 1.5);
      }
    }

    this.G.lanes.forEach((L, i) => {
      // 未来侧：基线虚线 + 下次唤醒空心点
      if (xn < W) {
        ctx.strokeStyle = K.hair2;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(Math.max(0, xn), L.base); ctx.lineTo(W, L.base); ctx.stroke();
        ctx.setLineDash([]);
      }
      const profile = this.profiles[i];
      const w = laneWake(profile, this.byLane[i] ?? []);
      if (w.status === "waiting" && w.target) {
        const x = this.xOf(Math.max(w.target, n)); // 已到期：钉在现在线上（"即将触发"）
        if (x <= W - 8) {
          ctx.beginPath(); ctx.arc(x, L.base, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = K.bg; ctx.fill();
          ctx.strokeStyle = K.ink2; ctx.lineWidth = 1.3; ctx.stroke(); ctx.lineWidth = 1;
          this.wakeHits.push({ lane: i, x, y: L.base, target: w.target });
        } else {
          // 超出视窗：右缘小标签
          const lbl = `${pulseText("pulseNextShort", "Next", "下次")} ${sameDay(w.target, n) ? "" : `${pulseText("pulseTomorrow", "tmrw", "明日")} `}${fHM(w.target)} →`;
          ctx.font = `10.5px ${K.fontNum}`;
          const tw = ctx.measureText(lbl).width + 12;
          const bx = W - tw - 6;
          const by = L.base - 9;
          ctx.fillStyle = K.s2; roundRect(ctx, bx, by, tw, 18, 3); ctx.fill();
          ctx.strokeStyle = K.hair3; ctx.stroke();
          ctx.fillStyle = K.ink2; ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(lbl, bx + 6, by + 9.5);
          this.wakeHits.push({ lane: i, x: bx + tw / 2, y: L.base, target: w.target, w: tw, off: true });
        }
      }
      // 运行中：唯一发光、唯一动画
      for (const r of this.byLane[i] ?? []) {
        if (r.status !== "running") continue;
        const g = this.pulseGeom(r, L);
        const breathe = this.RM ? 1 : 0.72 + 0.28 * Math.sin(ts / 520);
        ctx.save();
        ctx.shadowColor = K.ai;
        ctx.shadowBlur = 14 * breathe;
        ctx.beginPath();
        ctx.moveTo(g.x0, L.base); ctx.lineTo(g.x0 + 2.5, L.base - g.h); ctx.lineTo(g.x1, L.base - g.h); ctx.lineTo(g.x1, L.base);
        const grad = ctx.createLinearGradient(0, L.base - g.h, 0, L.base);
        grad.addColorStop(0, this.A("ai", 0.5 * breathe));
        grad.addColorStop(1, this.A("ai", 0.08));
        ctx.fillStyle = grad; ctx.fill();
        ctx.beginPath(); ctx.moveTo(g.x0, L.base); ctx.lineTo(g.x0 + 2.5, L.base - g.h); ctx.lineTo(g.x1, L.base - g.h);
        ctx.strokeStyle = K.aiHi; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.restore();
        // 前沿扫描线
        ctx.fillStyle = this.A("aiHi", 0.9);
        ctx.fillRect(g.x1 - 1, L.base - g.h - 3, 2, g.h + 3);
        this.hitList = this.hitList.filter((h) => h.r.id !== r.id);
        this.hitList.push({ r, lane: i, x0: g.x0, x1: g.x1 + 3, top: L.base - g.h - 12, bot: L.base + 4, pri: 3 });
      }
    });

    // 悬停
    const hover = this.S.hover;
    if (hover && hover.r.id !== this.S.sel?.id) {
      const L = this.G.lanes[hover.lane];
      if (L) this.outlineRun(ctx, hover.r, L, this.pulseGeom(hover.r, L), K.ink2, 1.2);
    }

    // 现在线
    if (xn >= 0 && xn <= W) {
      const x = Math.round(xn) + 0.5;
      ctx.strokeStyle = this.A("ink2", 0.55);
      ctx.beginPath(); ctx.moveTo(x, AXIS_H); ctx.lineTo(x, H); ctx.stroke();
      this.chip(ctx, x, `${pulseText("pulseNow", "Now", "现在")} ${fHMS(n)}`, K.ink, K.bg);
    }
    // 十字准线 + 时间
    const mouse = this.S.mouse;
    if (mouse && !this.S.drag && mouse.y > AXIS_H) {
      const x = Math.round(mouse.x) + 0.5;
      ctx.strokeStyle = K.hair3;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, AXIS_H); ctx.lineTo(x, H); ctx.stroke();
      ctx.setLineDash([]);
      if (Math.abs(x - xn) > 70) this.chip(ctx, x, fStamp(this.tOf(mouse.x), n).slice(0, -3), K.s3, K.ink2);
    }
  }

  private chip(ctx: CanvasRenderingContext2D, x: number, text: string, bg: string, fg: string) {
    ctx.font = `10.5px ${this.K!.fontNum}`;
    const tw = ctx.measureText(text).width + 12;
    const bx = clamp(x - tw / 2, 2, this.G.w - tw - 2);
    ctx.fillStyle = bg; roundRect(ctx, bx, 4, tw, 18, 3); ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(text, bx + 6, 13.5);
  }

  private outlineRun(ctx: CanvasRenderingContext2D, r: PulseRun, L: LaneGeom, g: Geom, col: string, lw: number) {
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    if (isFailedRun(r)) {
      const c = (g.x0 + g.x1) / 2;
      const hw = Math.max(4.5, (g.x1 - g.x0) / 2);
      ctx.beginPath(); ctx.moveTo(c - hw - 2, L.base - 1); ctx.lineTo(c, L.base + 14); ctx.lineTo(c + hw + 2, L.base - 1); ctx.closePath(); ctx.stroke();
    } else if (!isDeep(r) && r.status !== "running") {
      ctx.strokeRect(g.x0 - 1.5, L.base - g.h - 2.5, g.x1 - g.x0 + 3, g.h + 2.5);
    } else {
      tracePulse(ctx, g.x0, g.x1, L.base, g.h, 1.5);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  // ============================================================
  // 总览 + 刷选
  // ============================================================
  private ovX = (t: number) => { const { d0, d1 } = this.domain(); return 4 + ((t - d0) / (d1 - d0)) * (this.OG.w - 8); };
  private ovT = (x: number) => { const { d0, d1 } = this.domain(); return d0 + ((x - 4) / (this.OG.w - 8)) * (d1 - d0); };

  private drawOv() {
    const ctx = this.octx;
    const K = this.K;
    if (!ctx || !K) return;
    const { w: W, h: H } = this.OG;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    const n = this.now();
    const rows = Math.max(1, this.profiles.length);
    const top = 6;
    const rowH = (H - 12) / rows;
    const d = new Date(this.dataStart);
    d.setHours(0, 0, 0, 0);
    for (let t = d.getTime() + DAY; t < n + 12 * HOUR; t += DAY) {
      const x = Math.round(this.ovX(t)) + 0.5;
      ctx.strokeStyle = K.hair;
      ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, H - 2); ctx.stroke();
    }
    this.byLane.forEach((runs, i) => {
      const y = top + i * rowH;
      const h = Math.max(3, rowH - 3);
      for (const r of runs) {
        const x = this.ovX(r.startedAt);
        if (isFailedRun(r)) { ctx.fillStyle = K.warn; ctx.fillRect(x - 1, y, 2, h); }
        else if (r.status === "running") { ctx.fillStyle = K.aiHi; ctx.fillRect(x - 1, y, 2.5, h); }
        else if (isDeep(r)) { ctx.fillStyle = K.ai; ctx.fillRect(x - 0.6, y, 1.4, h); }
        else if (this.S.showSkips) { ctx.fillStyle = K.skipOv; ctx.fillRect(x - 0.4, y + h * 0.55, 0.9, h * 0.45); }
      }
    });
    const xn = this.ovX(n);
    ctx.strokeStyle = this.A("ink2", 0.6);
    ctx.beginPath(); ctx.moveTo(Math.round(xn) + 0.5, 2); ctx.lineTo(Math.round(xn) + 0.5, H - 2); ctx.stroke();
    // 刷选框
    const bx0 = this.ovX(this.S.t0);
    const bx1 = this.ovX(this.S.t1);
    ctx.fillStyle = this.A("bg", 0.55);
    ctx.fillRect(0, 0, bx0, H);
    ctx.fillRect(bx1, 0, W - bx1, H);
    ctx.strokeStyle = K.ink3;
    ctx.strokeRect(Math.round(bx0) + 0.5, 1.5, Math.max(2, Math.round(bx1 - bx0) - 1), H - 3);
    ctx.fillStyle = K.ink2;
    for (const x of [bx0, bx1]) ctx.fillRect(Math.round(x) - 1.5, H / 2 - 7, 3, 14);
  }

  private bindBrush() {
    const ovC = this.ovC;
    const edge = (x: number) => {
      const bx0 = this.ovX(this.S.t0);
      const bx1 = this.ovX(this.S.t1);
      if (Math.abs(x - bx0) < 6) return "l" as const;
      if (Math.abs(x - bx1) < 6) return "r" as const;
      if (x > bx0 && x < bx1) return "m" as const;
      return null;
    };
    const onMove = (e: PointerEvent) => {
      const x = e.offsetX;
      const B = this.brush;
      if (!B.mode) {
        const m = edge(x);
        ovC.classList.toggle("is-edge", m === "l" || m === "r");
        return;
      }
      const t = this.ovT(x);
      if (B.mode === "m") this.setView(B.a0 + (t - B.grabT), B.a1 + (t - B.grabT));
      else if (B.mode === "l") this.setView(Math.min(t, B.a1 - 20 * MIN), B.a1);
      else this.setView(B.a0, Math.max(t, B.a0 + 20 * MIN));
    };
    const onDown = (e: PointerEvent) => {
      try { ovC.setPointerCapture(e.pointerId); } catch { /* 合成事件没有活动指针 */ }
      let m = edge(e.offsetX);
      if (!m) {
        const span = this.S.t1 - this.S.t0;
        const c = this.ovT(e.offsetX);
        this.setView(c - span / 2, c + span / 2);
        m = "m";
      }
      this.brush = { mode: m, grabT: this.ovT(e.offsetX), a0: this.S.t0, a1: this.S.t1 };
      ovC.classList.add("is-drag");
    };
    const onUp = () => {
      this.brush.mode = null;
      ovC.classList.remove("is-drag");
    };
    ovC.addEventListener("pointermove", onMove);
    ovC.addEventListener("pointerdown", onDown);
    ovC.addEventListener("pointerup", onUp);
    ovC.addEventListener("pointercancel", onUp);
    this.cleanups.push(() => {
      ovC.removeEventListener("pointermove", onMove);
      ovC.removeEventListener("pointerdown", onDown);
      ovC.removeEventListener("pointerup", onUp);
      ovC.removeEventListener("pointercancel", onUp);
    });
  }

  // ============================================================
  // 交互
  // ============================================================
  private hitTest(x: number, y: number): { run?: RunHit; wake?: WakeHit } | null {
    for (const w of this.wakeHits) {
      if (w.off ? (Math.abs(x - w.x) < (w.w ?? 0) / 2 + 2 && Math.abs(y - w.y) < 11) : Math.hypot(x - w.x, y - w.y) < 8) return { wake: w };
    }
    let best: RunHit | null = null;
    let bd = Infinity;
    for (const h of this.hitList) {
      if (y < h.top || y > h.bot) continue;
      if (x < h.x0 - 4 || x > h.x1 + 4) continue;
      const c = (h.x0 + h.x1) / 2;
      const d = (x >= h.x0 && x <= h.x1 ? 0 : Math.abs(x - c)) - h.pri * 3;
      if (d < bd) { bd = d; best = h; }
    }
    return best ? { run: best } : null;
  }

  private emitHover(hit: { run?: RunHit; wake?: WakeHit } | null) {
    if (!hit) { this.cb.onHover(null); return; }
    if (hit.wake) {
      this.cb.onHover({ kind: "wake", lane: hit.wake.lane, target: hit.wake.target, ax: hit.wake.x, ay: hit.wake.y - 10 });
      return;
    }
    const h = hit.run!;
    const L = this.G.lanes[h.lane];
    const g = this.pulseGeom(h.r, L);
    this.cb.onHover({ kind: "run", run: h.r, lane: h.lane, ax: (g.x0 + g.x1) / 2, ay: L.base - g.h - 12 });
  }

  private bindPlot() {
    const liveC = this.liveC;
    const plot = this.plot;
    let lastHoverKey = "";
    const onMove = (e: PointerEvent) => {
      const x = e.offsetX;
      const y = e.offsetY;
      this.S.mouse = { x, y };
      this.liveDirty = true;
      const drag = this.S.drag;
      if (drag) {
        const dt = ((x - drag.x) / (this.G.w - PAD_L - PAD_R)) * (drag.t1 - drag.t0);
        if (Math.abs(x - drag.x) > 3) drag.moved = true;
        if (drag.moved) plot.classList.add("is-drag");
        this.setView(drag.t0 - dt, drag.t1 - dt);
        return;
      }
      const hit = this.hitTest(x, y);
      this.S.hover = hit?.run ?? null;
      plot.classList.toggle("is-pulse", Boolean(hit));
      const key = hit?.run ? `r:${hit.run.r.id}` : hit?.wake ? `w:${hit.wake.lane}` : "";
      if (key !== lastHoverKey) {
        lastHoverKey = key;
        this.emitHover(hit);
      }
      const li = this.G.lanes.findIndex((L) => y >= L.top && y < L.top + L.h);
      this.cb.onLaneHover(li);
    };
    const onLeave = () => {
      if (this.S.drag) return;
      this.S.mouse = null;
      this.S.hover = null;
      this.liveDirty = true;
      lastHoverKey = "";
      this.cb.onHover(null);
      this.cb.onLaneHover(-1);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      try { liveC.setPointerCapture(e.pointerId); } catch { /* 合成事件没有活动指针 */ }
      this.S.drag = { x: e.offsetX, t0: this.S.t0, t1: this.S.t1, moved: false };
      lastHoverKey = "";
      this.cb.onHover(null);
    };
    const onUp = (e: PointerEvent) => {
      const d = this.S.drag;
      this.S.drag = null;
      plot.classList.remove("is-drag");
      if (d && !d.moved) {
        const hit = this.hitTest(e.offsetX, e.offsetY);
        if (hit?.run) this.cb.onSelect(hit.run.r);
        else if (hit?.wake) { /* 仅提示 */ }
        else if (this.S.sel) this.cb.onSelect(null);
      }
    };
    const onDbl = () => this.resetWindow();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      lastHoverKey = "";
      this.cb.onHover(null);
      const span = this.S.t1 - this.S.t0;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dt = (e.deltaX / (this.G.w - PAD_L - PAD_R)) * span;
        this.setView(this.S.t0 + dt, this.S.t1 + dt);
        return;
      }
      const f = Math.exp(clamp(e.deltaY, -120, 120) * 0.0022);
      const tc = this.tOf(e.offsetX);
      this.setView(tc - (tc - this.S.t0) * f, tc + (this.S.t1 - tc) * f);
    };
    liveC.addEventListener("pointermove", onMove);
    liveC.addEventListener("pointerleave", onLeave);
    liveC.addEventListener("pointerdown", onDown);
    liveC.addEventListener("pointerup", onUp);
    liveC.addEventListener("dblclick", onDbl);
    liveC.addEventListener("wheel", onWheel, { passive: false });
    this.cleanups.push(() => {
      liveC.removeEventListener("pointermove", onMove);
      liveC.removeEventListener("pointerleave", onLeave);
      liveC.removeEventListener("pointerdown", onDown);
      liveC.removeEventListener("pointerup", onUp);
      liveC.removeEventListener("dblclick", onDbl);
      liveC.removeEventListener("wheel", onWheel);
    });
  }

  // ============================================================
  // 帧循环
  // ============================================================
  private frame = (ts: number) => {
    if (this.disposed) return;
    const n = this.now();
    // 跟随现在：视窗随时间右移
    if (this.S.follow && !this.S.drag) {
      const span = this.S.t1 - this.S.t0;
      const w = WINDOWS[this.S.win];
      const fut = w.fut / (1 + w.fut);
      const want = n + span * fut;
      if (want - this.S.t1 > span / 4000) {
        this.S.t1 = want;
        this.S.t0 = want - span;
        this.baseDirty = true;
        this.liveDirty = true;
      }
    }
    if (this.baseDirty || ts - this.lastBase > 5000) {
      this.drawBase();
      this.drawOv();
      this.baseDirty = false;
      this.lastBase = ts;
      this.liveDirty = true;
    }
    const second = ts - this.lastSec > 1000;
    // 只有运行中的脉冲在呼吸；没有运行中或减弱动效时只在变化 / 每秒重画动态层。
    const animating = !this.RM && this.hasRunning;
    if (animating || this.liveDirty || second) {
      this.drawLive(ts);
      this.liveDirty = false;
    }
    if (second) {
      this.lastSec = ts;
      this.cb.onSecond();
    }
    this.raf = requestAnimationFrame(this.frame);
  };
}
