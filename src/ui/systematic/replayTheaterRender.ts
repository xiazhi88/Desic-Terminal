/*
 * replayTheaterRender.ts — 回放剧场的画布引擎。
 * 绘制与交互移植自 viz/prototypes/replay-theater.html 第 3–14 节：
 * 五条同步轨道（价格 / 交易带 / 权益 / 水下回撤 / 保证金占用）、预加载斜纹、播放头之后变暗、
 * 唯一发光的播放头、浮起的策略动作理由、概览导航与刷选缩放、键盘快捷键。
 *
 * 性能约定：播放头、视图与悬停都保存在引擎内部（不进入 React state），
 * 由 requestAnimationFrame 按需重绘；HUD / 时钟 / 轨道读数直接写 DOM，只在所指 K 线变化时写。
 */
import type { SystematicReplaySnapshot, SystematicStrategyActionEvent } from "../../lib/systematic";
import {
  type CoverageSet,
  type EquitySeries,
  type TheaterBarStore,
  type TheaterEvent,
  type TheaterRound,
  type TheaterTimeline,
  groupActions,
  roundActions,
  seriesIndexAtOrBefore,
  snapshotIndexAtOrBefore,
  tOfU,
  uOfT,
} from "./replayTheaterModel";

export type TheaterData = {
  tl: TheaterTimeline;
  bars: TheaterBarStore;
  rounds: TheaterRound[];
  maxAbsNet: number;
  equity: EquitySeries;
  initialEquity: number;
  snapshots: readonly SystematicReplaySnapshot[];
  /** Evaluation windows (in global bar units) whose snapshots and actions are loaded. */
  cover: CoverageSet;
  actions: readonly SystematicStrategyActionEvent[];
  events: TheaterEvent[];
  equityArchived: boolean;
  hasSnapshotRecords: boolean;
  instId: string;
};

export type TheaterCopy = ReturnType<typeof theaterCopy>;

export function theaterCopy(chinese: boolean) {
  const zh = chinese;
  return {
    zh,
    tracks: zh ? "回放多轨时间线：价格、交易带、权益、水下回撤、保证金占用" : "Replay timeline: price, trade ribbon, equity, underwater drawdown, used margin",
    price: zh ? "价格" : "Price",
    ribbon: zh ? "交易带" : "Trade ribbon",
    equity: zh ? "权益" : "Equity",
    drawdown: zh ? "水下回撤" : "Underwater",
    margin: zh ? "保证金占用" : "Used margin",
    ribbonSub: zh ? "条带跨越开仓→平仓 · 厚度 ∝ |净盈亏| · 多在上 空在下" : "Entry→exit span · thickness ∝ |net PnL| · long above, short below",
    equitySub: zh ? "实线 权益 · 虚线 高水位" : "Solid equity · dashed high-water mark",
    ddSub: zh ? "相对高水位" : "Below high-water mark",
    marginSub: zh ? "多 ↑ 空 ↓" : "Long ↑ short ↓",
    aggregated: zh ? "每像素列聚合" : "per-pixel aggregate",
    pricePaging: zh ? "价格按需分页加载中" : "loading price pages",
    priceZoomIn: zh ? "区间过宽 · 缩小范围后加载价格" : "range too wide · zoom in to load prices",
    marginPartial: zh ? "快照按需分页 · 空白处尚未加载" : "snapshots load per page · blanks not yet loaded",
    noSnapshots: zh ? "该报告无回放快照" : "no replay snapshots in this report",
    playheadPrefix: zh ? "播放头 " : "Playhead ",
    o: zh ? "开" : "O", h: zh ? "高" : "H", l: zh ? "低" : "L", c: zh ? "收" : "C",
    preload: zh ? "预加载" : "Preload",
    preloadBars: (n: string) => (zh ? `预加载 ${n} 根` : `Preload ${n} bars`),
    preloadNote: zh ? "策略可见 · 不计入权益与统计" : "Strategy-visible · excluded from equity & stats",
    preloadShort: zh ? "不计入统计" : "Not in stats",
    noEquityRecord: zh ? "无权益记录" : "No equity record",
    preloadNoRecord: zh ? "预加载 · 无记录" : "Preload · no record",
    notLoaded: zh ? "尚未加载" : "not loaded",
    flat: zh ? "空仓" : "Flat",
    highWater: zh ? "高水位" : "HWM",
    available: zh ? "可用" : "avail.",
    initial: zh ? "初始" : "Initial",
    maxDd: zh ? "最大回撤" : "Max DD",
    archived: zh ? "逐根权益已归档，指标与成交仍完整" : "Per-bar equity archived; metrics and fills remain exact",
    entryAvg: zh ? "开仓均价" : "Avg entry",
    long: zh ? "多" : "L", short: zh ? "空" : "S",
    longUp: zh ? "多 ▲" : "Long ▲", shortDown: zh ? "空 ▼" : "Short ▼",
    hudTime: zh ? "时间" : "Time",
    hudPosition: zh ? "仓位" : "Position",
    hudUnrealized: zh ? "未实现" : "Unrealized",
    hudEquity: zh ? "权益" : "Equity",
    hudCash: zh ? "虚拟余额" : "Cash",
    hudStop: zh ? "止损" : "Stop",
    hudNoAction: zh ? "尚无动作" : "No action yet",
    contracts: zh ? " 张" : " ct",
    evalBars: (e: string, total: string) => (zh ? `评估 ${e} / ${total} 根` : `Eval ${e} / ${total} bars`),
    buy: zh ? "买入" : "Buy", sell: zh ? "卖出" : "Sell",
    play: zh ? "播放 (空格)" : "Play (Space)",
    pause: zh ? "暂停 (空格)" : "Pause (Space)",
    replayFromStart: zh ? "从头回放 (空格)" : "Replay from start (Space)",
    reason: (reason: string) => REASON[reason]?.[zh ? 0 : 1] ?? reason,
    reasonShort: (reason: string) => REASON_SHORT[reason]?.[zh ? 0 : 1] ?? reason,
    kind: (action: SystematicStrategyActionEvent["action"]) => kindLabel(action, zh),
    duration: (ms: number) => formatDuration(ms, zh),
  };
}

const REASON: Record<string, [string, string]> = {
  targetIncrease: ["开仓", "Entry"], targetDecrease: ["策略平仓", "Strategy exit"], targetFlipExit: ["反手平仓", "Flip exit"],
  targetFlipEntry: ["反手开仓", "Flip entry"], limitEntry: ["限价开仓", "Limit entry"], limitExit: ["限价平仓", "Limit exit"],
  protectiveStop: ["保护止损", "Protective stop"], protectiveTakeProfit: ["保护止盈", "Take profit"],
  marginExhaustion: ["保证金耗尽", "Margin exhausted"], endOfRunClose: ["期末平仓", "End-of-run close"],
};
const REASON_SHORT: Record<string, [string, string]> = {
  targetDecrease: ["策略", "Strat"], targetFlipExit: ["反手", "Flip"], limitExit: ["限价", "Limit"],
  protectiveStop: ["止损", "Stop"], protectiveTakeProfit: ["止盈", "TP"], marginExhaustion: ["强平", "Margin"],
  endOfRunClose: ["期末", "End"],
};

function kindLabel(action: SystematicStrategyActionEvent["action"], zh: boolean) {
  const q = action.quantity ? (zh ? ` ${action.quantity} 张` : ` ${action.quantity} ct`) : "";
  switch (action.kind) {
    case "open_long": return zh ? "开多" : "Open long";
    case "open_short": return zh ? "开空" : "Open short";
    case "close_long": return action.quantity ? (zh ? "减多" : "Reduce long") + q : zh ? "平多" : "Close long";
    case "close_short": return action.quantity ? (zh ? "减空" : "Reduce short") + q : zh ? "平空" : "Close short";
    case "set_protection": return zh ? "修改保护" : "Set protection";
    case "cancel_protection": return zh ? "撤销保护" : "Cancel protection";
    default: return action.kind;
  }
}

// ── 格式化（交易数值统一 en-US，负号用 U+2212） ──
export const MINUS = "−";
const nf = (d: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const NF0 = nf(0);
export const NF1 = nf(1);
export const NF2 = nf(2);
const QTY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
export const qtyFmt = (x: number) => QTY.format(x);
export const f2 = (x: number) => (x < 0 ? MINUS : "") + NF2.format(Math.abs(x));
export const s2 = (x: number) => (x > 0 ? "+" : x < 0 ? MINUS : "") + NF2.format(Math.abs(x));
export const pct = (x: number, d = 2) => (x > 0 ? "+" : x < 0 ? MINUS : "") + (Math.abs(x) * 100).toFixed(d) + "%";
export function priceFmt(x: number) {
  const a = Math.abs(x);
  const d = a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(x);
}
export const pad = (n: number) => String(n).padStart(2, "0");
export const fT = (ms: number) => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fD = (ms: number) => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fHM = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export function formatDuration(ms: number, zh: boolean) {
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (zh) {
    if (d) return `${d}天${h ? h + "时" : ""}`;
    if (h) return `${h}时${mm ? mm + "分" : ""}`;
    return `${mm}分`;
  }
  if (d) return `${d}d${h ? ` ${h}h` : ""}`;
  if (h) return `${h}h${mm ? ` ${mm}m` : ""}`;
  return `${mm}m`;
}
export const pnlCls = (x: number) => (x > 0 ? "is-pos" : x < 0 ? "is-neg" : "");
export const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
type RGB = [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

type Colors = {
  ink: RGB; ink2: RGB; ink3: RGB; ink4: RGB; s1: RGB; s2: RGB; s3: RGB; bg: RGB;
  pos: RGB; neg: RGB; sig: RGB; warn: RGB; hair: string; hair2: string; hair3: string; fNum: string; fUi: string;
};

export type TheaterHost = {
  root: HTMLElement;
  tracks: HTMLElement;
  canvas: HTMLCanvasElement;
  labels: HTMLElement;
  floats: HTMLElement;
  tip: HTMLElement;
  nav: HTMLCanvasElement;
  hud: HTMLElement;
  clockD: HTMLElement;
  clockS: HTMLElement;
  zoomN: HTMLElement;
  play: HTMLButtonElement;
  list: HTMLElement;
};

export type TheaterCallbacks = {
  onSelect: (round: TheaterRound | null) => void;
  onPlayingChange: (playing: boolean) => void;
};

const PAD_L = 10;
const GUT = 70;
const AX = 22;
const HEAD = 18;
const RIB = 78;
const FUT = 0.26;
const MIN_SPAN = 24;
const TRACK_IDS = ["price", "rib", "eq", "dd", "ex"] as const;
type TrackId = typeof TRACK_IDS[number];
type TrackBox = { y: number; h: number; py: number; ph: number };
const TRACK_WEIGHT: Record<TrackId, number> = { price: 0.5, rib: 0, eq: 0.25, dd: 0.125, ex: 0.125 };

const PLAY_ICON = '<svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M4 2.2v9.6a.6.6 0 00.92.5l7.2-4.8a.6.6 0 000-1l-7.2-4.8A.6.6 0 004 2.2z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="3" height="10" rx="1"/><rect x="8" y="2" width="3" height="10" rx="1"/></svg>';

type DragState =
  | { mode: "scrub" }
  | { mode: "band"; round: TheaterRound; x0: number }
  | { mode: "brush"; x0: number; x1: number };

type NavDrag = { mode: "l" } | { mode: "r" } | { mode: "pan"; x0: number; v0: number; v1: number } | { mode: "new"; x0: number };

type LiveFloat = { el: HTMLElement; u: number; slot: number; w: number; timer: number };

export class ReplayTheaterEngine {
  private data: TheaterData;
  private copy: TheaterCopy;
  private readonly host: TheaterHost;
  private readonly cb: TheaterCallbacks;
  private ctx: CanvasRenderingContext2D | null = null;
  private nctx: CanvasRenderingContext2D | null = null;
  private W = 0;
  private H = 0;
  private NW = 0;
  private NH = 0;
  private dpr = 1;
  private readonly L = { x0: 0, x1: 0, pw: 0, axisY: 0 } as { x0: number; x1: number; pw: number; axisY: number } & Record<TrackId, TrackBox>;
  private C!: Colors;
  private hatch: CanvasPattern | null = null;
  private readonly probe: CanvasRenderingContext2D | null;
  private readonly rm: MediaQueryList;
  // 视图 / 播放状态（K 线坐标）
  v0 = 0;
  v1 = 1;
  p = 0;
  playing = false;
  speed = 16;
  private stopAt: number | null = null;
  sel: TheaterRound | null = null;
  private hover: TheaterRound | null = null;
  private hx: number | null = null;
  private dragging = false;
  private drag: DragState | null = null;
  private ndrag: NavDrag | null = null;
  private viewAnim: { from: [number, number]; to: [number, number]; t: number } | null = null;
  private dirty = true;
  private raf = 0;
  private tPrev = 0;
  private destroyed = false;
  private priceScale: { lo: number; hi: number; y: (v: number) => number } | null = null;
  private eqScale: { lo: number; hi: number; y: (v: number) => number } | null = null;
  private labelEls: Partial<Record<TrackId, { rd: HTMLElement; sub: HTMLElement }>> = {};
  private priceSubState = "";
  private lastReadKey = "";
  private lastHudKey = "";
  private lastListP = -1;
  private maxMargin = 1;
  private live: LiveFloat[] = [];
  private rowEls = new Map<number, HTMLElement>();
  private readonly ro: ResizeObserver;
  private readonly mo: MutationObserver;
  private readonly disposers: Array<() => void> = [];

  constructor(host: TheaterHost, data: TheaterData, copy: TheaterCopy, cb: TheaterCallbacks) {
    this.host = host;
    this.data = data;
    this.copy = copy;
    this.cb = cb;
    this.probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    this.rm = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.v0 = 0;
    this.v1 = Math.max(MIN_SPAN, data.tl.totalBars);
    this.p = data.tl.totalBars;
    this.recomputeDerived();
    this.readTokens();
    this.layout();
    this.bind();
    this.ro = new ResizeObserver(() => { this.layout(); this.draw(); });
    this.ro.observe(host.tracks);
    this.ro.observe(host.nav);
    // 外观切换（磷光 / 经典）或涨跌色 token 变化时重新读取颜色
    this.mo = new MutationObserver(() => { this.readTokens(); this.makeHatch(); this.dirty = true; });
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-visual", "class", "style", "data-updown"] });
    this.updateHud(true);
    this.updateClock();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.mo.disconnect();
    this.disposers.forEach((dispose) => dispose());
    this.live.forEach((item) => { window.clearTimeout(item.timer); item.el.remove(); });
    this.live = [];
  }

  // ============================================================
  // 数据
  // ============================================================
  setData(data: TheaterData) {
    const selId = this.sel?.key ?? null;
    const hovId = this.hover?.key ?? null;
    this.data = data;
    this.sel = selId ? data.rounds.find((round) => round.key === selId) ?? null : null;
    this.hover = hovId ? data.rounds.find((round) => round.key === hovId) ?? null : null;
    this.recomputeDerived();
    this.lastReadKey = "";
    this.priceSubState = "";
    this.updateHud(true);
    this.updateClock();
    this.dirty = true;
  }

  setCopy(copy: TheaterCopy) {
    this.copy = copy;
    this.buildLabels();
    this.lastReadKey = "";
    this.updateHud(true);
    this.updateClock();
    this.dirty = true;
  }

  private recomputeDerived() {
    let maxMargin = 1;
    for (const round of this.data.rounds) maxMargin = Math.max(maxMargin, round.margin);
    for (const snapshot of this.data.snapshots) maxMargin = Math.max(maxMargin, snapshot.usedMarginUsdt || 0);
    this.maxMargin = maxMargin;
  }

  /** What the loader should fetch next, in evaluation-bar units. */
  needs() {
    const pre = this.data.tl.preloadBars;
    const ev = this.data.tl.evalBars;
    return {
      playhead: clamp(Math.floor(this.p) - 1 - pre, 0, Math.max(0, ev - 1)),
      viewStart: clamp(Math.floor(this.v0) - pre, 0, ev),
      viewEnd: clamp(Math.ceil(this.v1) - pre, 0, ev),
      selected: this.sel ? [clamp(Math.floor(this.sel.u0) - pre - 2, 0, ev), clamp(Math.ceil(this.sel.u1) - pre + 2, 0, ev)] as const : null,
      playing: this.playing,
      speed: this.speed,
    };
  }

  // ============================================================
  // 颜色令牌：读取剧场根节点上的作用域变量（跟随 --up / --down 与外观）
  // ============================================================
  private rgbOf(col: string): RGB {
    const g = this.probe;
    if (!g) return [128, 128, 128];
    g.clearRect(0, 0, 2, 2);
    g.fillStyle = "#000";
    g.fillStyle = col || "#000";
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  readTokens() {
    const cs = getComputedStyle(this.host.root);
    const tk = (name: string) => cs.getPropertyValue(name).trim();
    this.C = {
      ink: this.rgbOf(tk("--rt-ink")), ink2: this.rgbOf(tk("--rt-ink-2")), ink3: this.rgbOf(tk("--rt-ink-3")), ink4: this.rgbOf(tk("--rt-ink-4")),
      s1: this.rgbOf(tk("--rt-s1")), s2: this.rgbOf(tk("--rt-s2")), s3: this.rgbOf(tk("--rt-s3")), bg: this.rgbOf(tk("--rt-bg")),
      pos: this.rgbOf(tk("--rt-pos")), neg: this.rgbOf(tk("--rt-neg")), sig: this.rgbOf(tk("--rt-signal")), warn: this.rgbOf(tk("--rt-warn")),
      hair: tk("--rt-hair") || "rgba(200,200,230,0.075)", hair2: tk("--rt-hair-2") || "rgba(200,200,230,0.13)", hair3: tk("--rt-hair-3") || "rgba(200,200,230,0.22)",
      fNum: tk("--rt-font-num") || "ui-monospace, monospace", fUi: tk("--rt-font-ui") || "system-ui, sans-serif",
    };
  }

  private pnlRGB(x: number) { return x >= 0 ? this.C.pos : this.C.neg; }
  private get reduced() { return this.rm.matches; }

  // ============================================================
  // 布局
  // ============================================================
  private fit(canvas: HTMLCanvasElement) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, dpr, w: rect.width, h: rect.height };
  }

  private layout() {
    const f = this.fit(this.host.canvas);
    this.ctx = f.ctx; this.W = f.w; this.H = f.h; this.dpr = f.dpr;
    const n = this.fit(this.host.nav);
    this.nctx = n.ctx; this.NW = n.w; this.NH = n.h;
    const L = this.L;
    L.x0 = PAD_L; L.x1 = this.W - GUT; L.pw = Math.max(1, L.x1 - L.x0);
    const avail = this.H - AX - RIB;
    let y = 0;
    for (const id of TRACK_IDS) {
      const h = id === "rib" ? RIB : Math.round(avail * TRACK_WEIGHT[id]);
      L[id] = { y, h, py: y + HEAD, ph: Math.max(4, h - HEAD - 6) };
      y += h;
    }
    L.axisY = this.H - AX;
    this.makeHatch();
    this.buildLabels();
    this.dirty = true;
  }

  private xOf = (u: number) => this.L.x0 + ((u - this.v0) / (this.v1 - this.v0)) * this.L.pw;
  private uOf = (x: number) => this.v0 + ((x - this.L.x0) / this.L.pw) * (this.v1 - this.v0);

  private buildLabels() {
    const host = this.host.labels;
    host.textContent = "";
    this.labelEls = {};
    const c = this.copy;
    const names: Record<TrackId, string> = { price: c.price, rib: c.ribbon, eq: c.equity, dd: c.drawdown, ex: c.margin };
    const subs: Record<TrackId, string> = { price: `${this.data.instId} · 1m`, rib: c.ribbonSub, eq: c.equitySub, dd: c.ddSub, ex: c.marginSub };
    for (const id of TRACK_IDS) {
      const el = document.createElement("div");
      el.className = "rt-tlabel";
      el.style.top = `${this.L[id].y + 3}px`;
      const b = document.createElement("b"); b.textContent = names[id];
      const sub = document.createElement("span"); sub.textContent = subs[id];
      const rd = document.createElement("span"); rd.className = "rt-tlabel__rd";
      el.append(b, sub, rd);
      host.append(el);
      this.labelEls[id] = { rd, sub };
    }
    this.lastReadKey = "";
    this.priceSubState = "";
  }

  // ============================================================
  // 绘制
  // ============================================================
  private makeHatch() {
    if (!this.ctx) return;
    const dpr = this.dpr;
    const c = document.createElement("canvas");
    c.width = c.height = Math.round(8 * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.strokeStyle = rgba(this.C.ink3, 0.22);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
    this.hatch = this.ctx.createPattern(c, "repeat");
    this.hatch?.setTransform(new DOMMatrix().scale(1 / dpr));
  }

  private clipRect(x0: number, y0: number, x1: number, y1: number) {
    const ctx = this.ctx!;
    ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
  }

  /** 播放头之前完整、之后变暗：同一绘制函数在两个裁剪区各跑一遍。 */
  private twoPass(tr: TrackBox, fn: (m: number) => void) {
    const ctx = this.ctx!;
    const L = this.L;
    const px = clamp(this.xOf(this.p), L.x0, L.x1);
    ctx.save(); this.clipRect(L.x0, tr.y, px, tr.y + tr.h); fn(1); ctx.restore();
    if (px < L.x1) { ctx.save(); this.clipRect(px, tr.y, L.x1, tr.y + tr.h); fn(FUT); ctx.restore(); }
  }

  private visRange(): [number, number] {
    const N = this.data.tl.totalBars;
    return [Math.max(0, Math.floor(this.v0) - 1), Math.min(N - 1, Math.ceil(this.v1) + 1)];
  }

  private niceStep(range: number, n: number) {
    const raw = range / n;
    const e = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / e;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e;
  }

  private yAxis(tr: TrackBox, lo: number, hi: number, fmt: (v: number) => string, count = 4, avoidY: number | null = null) {
    const ctx = this.ctx!;
    const L = this.L;
    if (!(hi > lo)) return;
    const st = this.niceStep(hi - lo, count);
    ctx.font = `10px ${this.C.fNum}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let lastY = -1e9;
    for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) {
      const y = tr.py + tr.ph - ((v - lo) / (hi - lo)) * tr.ph;
      if (y < tr.py + 4 || y > tr.py + tr.ph - 2) continue;
      if (Math.abs(y - lastY) < 15) continue;
      lastY = y;
      ctx.fillStyle = this.C.hair; ctx.fillRect(L.x0, Math.round(y) + 0.5, L.pw, 1);
      if (avoidY != null && Math.abs(y - avoidY) < 12) continue;
      ctx.fillStyle = rgba(this.C.ink4, 1); ctx.fillText(fmt(v), L.x1 + 8, y);
    }
  }

  private drawPrice() {
    const ctx = this.ctx!;
    const L = this.L;
    const C = this.C;
    const tr = L.price;
    const { bars, tl, rounds } = this.data;
    const PRE = tl.preloadBars;
    const [i0, i1] = this.visRange();
    let lo = Infinity;
    let hi = -Infinity;
    let loadedInView = 0;
    for (let i = i0; i <= i1; i++) {
      if (!bars.loaded[i]) continue;
      loadedInView += 1;
      if (bars.low[i]! < lo) lo = bars.low[i]!;
      if (bars.high[i]! > hi) hi = bars.high[i]!;
    }
    if (!(hi > lo)) {
      // 价格页尚未到达：用视图内回合的成交价估计纵轴，避免空白轨道
      for (const round of rounds) {
        if (round.u1 < this.v0 || round.u0 > this.v1) continue;
        lo = Math.min(lo, round.entryPrice, ...round.closes.map((close) => close.exitPrice));
        hi = Math.max(hi, round.entryPrice, ...round.closes.map((close) => close.exitPrice));
      }
    }
    const evalInView = Math.max(0, Math.min(i1, tl.totalBars - 1) - Math.max(i0, PRE) + 1);
    const pageState = evalInView > 0 && loadedInView < evalInView * 0.98
      ? (evalInView > 16 * 5000 ? "zoom" : "paging")
      : "ok";
    const bw = L.pw / (this.v1 - this.v0);
    const subState = `${pageState}:${bw < 2.6 ? "agg" : "bar"}`;
    if (subState !== this.priceSubState && this.labelEls.price) {
      this.priceSubState = subState;
      const parts = [`${this.data.instId} · 1m`];
      if (bw < 2.6) parts.push(this.copy.aggregated);
      if (pageState === "paging") parts.push(this.copy.pricePaging);
      if (pageState === "zoom") parts.push(this.copy.priceZoomIn);
      this.labelEls.price.sub.textContent = parts.join(" · ");
    }
    if (!(hi > lo)) { this.priceScale = null; return; }
    const padv = (hi - lo) * 0.08 || hi * 0.001 || 1;
    lo -= padv; hi += padv;
    const y = (v: number) => tr.py + tr.ph - ((v - lo) / (hi - lo)) * tr.ph;
    this.priceScale = { lo, hi, y };
    this.yAxis(tr, lo, hi, (v) => (Math.abs(v) >= 100 ? NF0.format(v) : priceFmt(v)), 5);
    const xOf = this.xOf;
    this.twoPass(tr, (m) => {
      if (bw >= 2.6) {
        const body = Math.max(1, Math.min(9, bw * 0.62));
        for (let i = i0; i <= i1; i++) {
          if (!bars.loaded[i]) continue;
          const o = bars.open[i]!, c = bars.close[i]!, h = bars.high[i]!, l = bars.low[i]!;
          const x = xOf(i + 0.5);
          ctx.globalAlpha = (i < PRE ? 0.38 : 0.9) * m;
          ctx.fillStyle = rgba(c >= o ? C.pos : C.neg, 1);
          ctx.fillRect(Math.round(x), y(h), 1, Math.max(1, y(l) - y(h)));
          const yo = y(o), yc = y(c);
          ctx.fillRect(Math.round(x - body / 2), Math.min(yo, yc), Math.round(body) || 1, Math.max(1, Math.abs(yc - yo)));
        }
      } else {
        // 每像素列聚合：高低区间 + 列内开收方向
        let col: number | null = null, h = 0, l = 0, o = 0, c = 0;
        const flush = () => {
          if (col === null) return;
          ctx.globalAlpha = 0.85 * m;
          ctx.fillStyle = rgba(c >= o ? C.pos : C.neg, 1);
          ctx.fillRect(col, y(h), 1, Math.max(1, y(l) - y(h)));
        };
        for (let i = i0; i <= i1; i++) {
          if (!bars.loaded[i]) continue;
          const cx = Math.floor(xOf(i + 0.5));
          if (cx !== col) { flush(); col = cx; h = bars.high[i]!; l = bars.low[i]!; o = bars.open[i]!; c = bars.close[i]!; }
          else { h = Math.max(h, bars.high[i]!); l = Math.min(l, bars.low[i]!); c = bars.close[i]!; }
        }
        flush();
      }
      ctx.globalAlpha = 1;
      // 开平仓标记
      for (const g of rounds) {
        if (g.u1 < this.v0 - 2 || g.u0 > this.v1 + 2) continue;
        const dim = this.sel && this.sel !== g ? 0.35 : 1;
        const x0 = xOf(g.u0);
        const e0 = g.fills[0];
        const yE = y(e0 ? e0.fillPrice : g.entryPrice);
        ctx.globalAlpha = 0.45 * m * dim;
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        for (const close of g.closes) {
          ctx.strokeStyle = rgba(this.pnlRGB(close.netPnlUsdt), 1);
          ctx.beginPath(); ctx.moveTo(x0, yE); ctx.lineTo(xOf(uOfT(tl, close.exitTimeMs)), y(close.exitPrice)); ctx.stroke();
        }
        ctx.setLineDash([]);
        // 开仓三角：多 ▲ 在价下，空 ▼ 在价上
        ctx.globalAlpha = m * dim;
        ctx.fillStyle = rgba(C.ink, 0.92);
        const long = g.side !== "short";
        const ty = long ? yE + 5 : yE - 5;
        ctx.beginPath();
        if (long) { ctx.moveTo(x0, ty); ctx.lineTo(x0 - 4.5, ty + 7); ctx.lineTo(x0 + 4.5, ty + 7); }
        else { ctx.moveTo(x0, ty); ctx.lineTo(x0 - 4.5, ty - 7); ctx.lineTo(x0 + 4.5, ty - 7); }
        ctx.closePath(); ctx.fill();
        // 平仓菱形：实心 = 最终平仓，空心 = 分批平仓
        g.closes.forEach((close, k) => {
          const xx = xOf(uOfT(tl, close.exitTimeMs)), yy = y(close.exitPrice);
          const col = rgba(this.pnlRGB(close.netPnlUsdt), 1);
          ctx.beginPath(); ctx.moveTo(xx, yy - 4); ctx.lineTo(xx + 4, yy); ctx.lineTo(xx, yy + 4); ctx.lineTo(xx - 4, yy); ctx.closePath();
          if (k === g.closes.length - 1) { ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = rgba(C.bg, 0.9); ctx.lineWidth = 1; ctx.stroke(); }
          else { ctx.fillStyle = rgba(C.bg, 1); ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.stroke(); }
        });
        ctx.globalAlpha = 1;
      }
    });
    // 选中回合：开仓均价、止损轨迹（来自快照 position.stopLoss）、动作编号
    const g = this.sel;
    if (g && g.u1 >= this.v0 && g.u0 <= this.v1) {
      ctx.save(); this.clipRect(L.x0, tr.py - 4, L.x1, tr.py + tr.ph);
      const xa = xOf(g.u0), xb = xOf(g.u1);
      ctx.strokeStyle = rgba(C.sig, 0.9); ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
      const ye = y(g.entryPrice);
      ctx.beginPath(); ctx.moveTo(xa, ye); ctx.lineTo(xb, ye); ctx.stroke();
      this.drawStopTrail(g, y, xb);
      ctx.font = `10px ${C.fUi}`; ctx.textBaseline = "bottom"; ctx.textAlign = "left";
      ctx.fillStyle = rgba(C.sig, 1);
      const lab = `${this.copy.entryAvg} ${priceFmt(g.entryPrice)}`;
      const tw = ctx.measureText(lab).width;
      const inside = xb - xa > tw + 40 || xb + 8 + tw > L.x1;
      ctx.textAlign = inside ? "right" : "left";
      ctx.fillText(lab, inside ? Math.min(L.x1 - 4, xb - 6) : xb + 8, g.side !== "short" ? ye + 13 : ye - 3);
      ctx.textAlign = "left";
      // 动作编号：与右侧卡片一致
      const laneX: number[] = [];
      groupActions(roundActions(g, this.data.actions)).forEach((ga, k) => {
        const xx = xOf(uOfT(tl, ga.first.asOfMs));
        if (xx < L.x0 - 8 || xx > L.x1 + 8) return;
        let lane = 0;
        while (lane < 3 && laneX[lane] != null && xx - laneX[lane]! < 17) lane++;
        laneX[lane] = xx;
        const yy = tr.py + 9 + lane * 17;
        ctx.strokeStyle = rgba(C.sig, 0.45); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xx + 0.5, yy + 7); ctx.lineTo(xx + 0.5, tr.py + tr.ph); ctx.stroke();
        ctx.fillStyle = rgba(C.s1, 1); ctx.beginPath(); ctx.arc(xx, yy, 7, 0, 7); ctx.fill();
        ctx.strokeStyle = rgba(C.sig, 1); ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = rgba(C.ink, 1); ctx.font = `600 9.5px ${C.fNum}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(k + 1), xx, yy + 0.5);
      });
      ctx.restore();
    }
  }

  /** 止损轨迹：快照在第 i 根收线记录的止损，从下一根开盘起生效；只画已加载的快照页。 */
  private drawStopTrail(g: TheaterRound, y: (v: number) => number, xb: number) {
    const ctx = this.ctx!;
    const { snapshots, tl, cover } = this.data;
    ctx.setLineDash([4, 3]); ctx.strokeStyle = rgba(this.C.warn, 0.75);
    ctx.beginPath();
    let started = false;
    let k = Math.max(0, snapshotIndexAtOrBefore(snapshots, g.entryTimeMs));
    for (; k < snapshots.length; k++) {
      const s = snapshots[k]!;
      if (s.timeMs > g.exitTimeMs) break;
      const sl = s.position && s.position.side === g.side ? s.position.stopLoss : null;
      const us = uOfT(tl, s.timeMs);
      if (sl == null || !cover.contains(us - 0.5)) { started = false; continue; }
      const next = snapshots[k + 1];
      let ue = next ? Math.min(uOfT(tl, next.timeMs), g.u1) : g.u1;
      // 快照只在已加载页内可信：延伸到所在覆盖区间末尾为止
      for (const [a, b] of cover.list()) if (us - 0.5 >= a && us - 0.5 <= b) ue = Math.min(ue, b);
      const xs = this.xOf(Math.max(us, g.u0)), xe = Math.min(this.xOf(ue), xb);
      const yy = y(sl);
      if (!started) { ctx.moveTo(xs, yy); started = true; } else ctx.lineTo(xs, yy);
      ctx.lineTo(xe, yy);
    }
    ctx.stroke(); ctx.setLineDash([]);
  }

  private tripHeight(g: TheaterRound, half: number) {
    return (half - 2) * (0.14 + 0.86 * Math.sqrt(Math.abs(g.net) / this.data.maxAbsNet));
  }

  private drawRibbon() {
    const ctx = this.ctx!;
    const L = this.L;
    const C = this.C;
    const tr = L.rib;
    const mid = Math.round(tr.py + tr.ph / 2) + 0.5, half = tr.ph / 2;
    ctx.fillStyle = C.hair2; ctx.fillRect(L.x0, mid - 0.5, L.pw, 1);
    ctx.font = `10px ${C.fUi}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = rgba(C.ink4, 1);
    ctx.fillText(this.copy.longUp, L.x1 + 8, mid - half / 2); ctx.fillText(this.copy.shortDown, L.x1 + 8, mid + half / 2);
    this.twoPass(tr, (m) => {
      for (const g of this.data.rounds) {
        if (g.u1 < this.v0 || g.u0 > this.v1) continue;
        const hh = this.tripHeight(g, half), up = g.side !== "short";
        const norm = Math.sqrt(Math.abs(g.net) / this.data.maxAbsNet);
        let a = 0.34 + 0.56 * norm;
        if (this.sel && this.sel !== g) a *= 0.35;
        if (this.hover === g && this.sel !== g) a = Math.min(1, a + 0.25);
        const col = this.pnlRGB(g.net);
        g.segs.forEach((sg, k) => {
          const xa = this.xOf(sg.u0), xb = Math.max(xa + 2, this.xOf(sg.u1));
          const h = hh * (0.45 + 0.55 * sg.frac);
          const yT = up ? mid - 1 - h : mid + 1;
          ctx.globalAlpha = a * m;
          ctx.fillStyle = rgba(col, 1);
          ctx.fillRect(xa, yT, xb - xa, h);
          // 外缘高亮一像素，让薄带也读得出
          ctx.globalAlpha = Math.min(1, a + 0.3) * m;
          ctx.fillRect(xa, up ? yT : yT + h - 1, xb - xa, 1);
          if (k > 0) { ctx.globalAlpha = m; ctx.fillStyle = rgba(C.bg, 1); ctx.fillRect(Math.round(xa), yT, 1, h); }
        });
        ctx.globalAlpha = 1;
      }
    });
    const outline = (g: TheaterRound, col: string, lw: number) => {
      const hh = this.tripHeight(g, half), up = g.side !== "short";
      const xa = this.xOf(g.u0), xb = Math.max(xa + 2, this.xOf(g.u1));
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.strokeRect(xa - 1.5, up ? mid - 2.5 - hh : mid + 0.5, xb - xa + 3, hh + 2);
    };
    ctx.save(); this.clipRect(L.x0 - 2, tr.y, L.x1 + 2, tr.y + tr.h);
    if (this.hover && this.hover !== this.sel) outline(this.hover, rgba(C.ink2, 0.7), 1);
    if (this.sel) outline(this.sel, rgba(C.sig, 1), 1.5);
    ctx.restore();
  }

  /** 视图内的序列点；点数远超像素列时按列保留 min / max。 */
  private seriesPath(values: Float64Array, y: (v: number) => number, startWithInit: number | null) {
    const eq = this.data.equity;
    const out: Array<[number, number]> = [];
    if (!eq.count) return out;
    const L = this.L;
    const k0 = Math.max(0, seriesIndexAtOrBefore(eq, this.v0));
    let k1 = seriesIndexAtOrBefore(eq, this.v1);
    if (k1 < 0) return out;
    k1 = Math.min(eq.count - 1, k1 + 1);
    if (k0 === 0 && startWithInit != null) out.push([this.xOf(this.data.tl.preloadBars), y(startWithInit)]);
    const dense = k1 - k0 > L.pw * 3;
    if (!dense) {
      for (let k = k0; k <= k1; k++) out.push([this.xOf(eq.u[k]!), y(values[k]!)]);
      return out;
    }
    let col = Number.NaN, mn = 0, mx = 0, first = 0, last = 0;
    const flush = () => {
      if (Number.isNaN(col)) return;
      out.push([col, y(first)]);
      if (mn !== first && mn !== last) out.push([col, y(mn)]);
      if (mx !== first && mx !== last) out.push([col, y(mx)]);
      out.push([col + 0.5, y(last)]);
    };
    for (let k = k0; k <= k1; k++) {
      const cx = Math.floor(this.xOf(eq.u[k]!));
      const v = values[k]!;
      if (cx !== col) { flush(); col = cx; mn = mx = first = last = v; }
      else { mn = Math.min(mn, v); mx = Math.max(mx, v); last = v; }
    }
    flush();
    return out;
  }

  private drawEquity() {
    const ctx = this.ctx!;
    const L = this.L;
    const C = this.C;
    const tr = L.eq;
    const eq = this.data.equity;
    const INIT = this.data.initialEquity;
    if (this.data.equityArchived || !eq.count) {
      ctx.font = `11px ${C.fUi}`; ctx.fillStyle = rgba(C.ink4, 1); ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(this.data.equityArchived ? this.copy.archived : this.copy.noEquityRecord, L.x0 + 12, tr.py + tr.ph / 2);
      this.eqScale = null;
      return;
    }
    let lo = INIT, hi = INIT;
    const k0 = Math.max(0, seriesIndexAtOrBefore(eq, this.v0));
    const k1 = Math.min(eq.count - 1, seriesIndexAtOrBefore(eq, this.v1) + 1);
    for (let k = k0; k <= k1; k++) { lo = Math.min(lo, eq.equity[k]!); hi = Math.max(hi, eq.hwm[k]!); }
    const p = (hi - lo) * 0.12 || 50; lo -= p; hi += p;
    const y = (v: number) => tr.py + tr.ph - ((v - lo) / (hi - lo)) * tr.ph;
    this.eqScale = { lo, hi, y };
    const yb = y(INIT);
    this.yAxis(tr, lo, hi, (v) => NF0.format(v), 3, yb);
    const line = this.seriesPath(eq.equity, y, INIT);
    const hwm = this.seriesPath(eq.hwm, y, INIT);
    if (line.length < 1) return;
    this.twoPass(tr, (m) => {
      // 相对初始权益的着色面积
      const path = new Path2D();
      path.moveTo(line[0]![0], yb);
      for (const [x, yy] of line) path.lineTo(x, yy);
      path.lineTo(line[line.length - 1]![0], yb); path.closePath();
      ctx.save(); this.clipRect(L.x0, tr.py - 2, L.x1, yb); ctx.globalAlpha = 0.08 * m; ctx.fillStyle = rgba(C.pos, 1); ctx.fill(path); ctx.restore();
      ctx.save(); this.clipRect(L.x0, yb, L.x1, tr.py + tr.ph + 2); ctx.globalAlpha = 0.08 * m; ctx.fillStyle = rgba(C.neg, 1); ctx.fill(path); ctx.restore();
      // 高水位
      ctx.globalAlpha = m; ctx.strokeStyle = rgba(C.ink3, 0.8); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath();
      hwm.forEach(([x, yy], k) => { if (k === 0) ctx.moveTo(x, yy); else { ctx.lineTo(x, hwm[k - 1]![1]); ctx.lineTo(x, yy); } });
      ctx.stroke(); ctx.setLineDash([]);
      // 权益线
      ctx.strokeStyle = rgba(C.ink, 0.92); ctx.lineWidth = 1.3; ctx.lineJoin = "round";
      ctx.beginPath();
      line.forEach(([x, yy], k) => (k === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy)));
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
    // 初始权益基线
    ctx.fillStyle = C.hair3; ctx.fillRect(L.x0, Math.round(yb) + 0.5, L.pw, 1);
    ctx.font = `10px ${C.fNum}`; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = rgba(C.ink3, 1);
    ctx.fillText(`${this.copy.initial} ${NF0.format(INIT)}`, L.x1 + 8, clamp(yb, tr.py + 4, tr.py + tr.ph - 2));
  }

  private drawDD() {
    const ctx = this.ctx!;
    const L = this.L;
    const C = this.C;
    const tr = L.dd;
    const eq = this.data.equity;
    if (!eq.count || this.data.equityArchived) return;
    const minDd = eq.minIdx >= 0 ? eq.dd[eq.minIdx]! : 0;
    const ddLo = Math.min(-0.001, minDd * 1.18);
    const y = (v: number) => tr.py + (v / ddLo) * tr.ph;
    this.yAxis(tr, ddLo, 0, (v) => (v === 0 ? "0%" : MINUS + Math.abs(v * 100).toFixed(Math.abs(ddLo) < 0.03 ? 1 : 0) + "%"), 3);
    const pts = this.seriesPath(eq.dd, y, 0);
    if (pts.length) {
      this.twoPass(tr, (m) => {
        ctx.beginPath(); ctx.moveTo(pts[0]![0], y(0));
        for (const [x, yy] of pts) ctx.lineTo(x, yy);
        ctx.lineTo(pts[pts.length - 1]![0], y(0)); ctx.closePath();
        ctx.globalAlpha = 0.3 * m; ctx.fillStyle = rgba(C.neg, 1); ctx.fill();
        ctx.beginPath();
        pts.forEach(([x, yy], k) => (k === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy)));
        ctx.globalAlpha = 0.85 * m; ctx.strokeStyle = rgba(C.neg, 1); ctx.lineWidth = 1; ctx.stroke();
        ctx.globalAlpha = 1;
      });
    }
    ctx.fillStyle = C.hair3; ctx.fillRect(L.x0, Math.round(y(0)) - 0.5, L.pw, 1);
    // 最大回撤标注
    if (eq.minIdx >= 0 && minDd < 0) {
      const xx = this.xOf(eq.u[eq.minIdx]!);
      if (xx >= L.x0 && xx <= L.x1) {
        const yy = y(minDd);
        ctx.fillStyle = rgba(C.neg, 1); ctx.beginPath(); ctx.arc(xx, yy, 2.5, 0, 7); ctx.fill();
        const t = `${this.copy.maxDd} ${pct(minDd)} · ${fT(eq.timeMs[eq.minIdx]!)}`;
        ctx.font = `10px ${C.fNum}`; ctx.textBaseline = "middle";
        const tw = ctx.measureText(t).width;
        const right = xx + 8 + tw < L.x1;
        ctx.textAlign = right ? "left" : "right";
        ctx.fillStyle = rgba(C.ink2, 1);
        ctx.fillText(t, right ? xx + 7 : xx - 7, Math.min(yy, tr.py + tr.ph - 6));
      }
    }
  }

  private drawExposure() {
    const ctx = this.ctx!;
    const L = this.L;
    const C = this.C;
    const tr = L.ex;
    const { snapshots, cover, tl } = this.data;
    const mid = Math.round(tr.py + tr.ph / 2) + 0.5, half = tr.ph / 2 - 1;
    ctx.fillStyle = C.hair2; ctx.fillRect(L.x0, mid - 0.5, L.pw, 1);
    ctx.font = `10px ${C.fNum}`; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = rgba(C.ink4, 1);
    ctx.fillText(NF0.format(this.maxMargin), L.x1 + 8, tr.py + 5);
    if (tr.ph >= 48) { ctx.fillText("0", L.x1 + 8, mid); ctx.fillText(NF0.format(this.maxMargin), L.x1 + 8, tr.py + tr.ph - 4); }
    if (!snapshots.length) return;
    const sel = this.sel;
    // 快照只记录状态变化：一条快照描述它所在 K 线（[u − 1, u]）直到下一条快照为止，
    // 且只在已加载的覆盖区间内可信。
    const segs: Array<[number, number, number, number]> = [];
    for (const [a, b] of cover.list()) {
      if (b < this.v0 || a > this.v1) continue;
      let k = Math.max(0, snapshotIndexAtOrBefore(snapshots, tOfU(tl, a + 1)));
      for (; k < snapshots.length; k++) {
        const s = snapshots[k]!;
        const us = uOfT(tl, s.timeMs) - 1;
        if (us > b) break;
        const next = snapshots[k + 1];
        const ue = Math.min(b, next ? uOfT(tl, next.timeMs) - 1 : b);
        const start = Math.max(a, us);
        if (!s.position || !(ue > start) || ue < this.v0 || start > this.v1) continue;
        segs.push([start, ue, s.usedMarginUsdt || s.position.usedMarginUsdt || 0, s.position.side === "short" ? -1 : 1]);
      }
    }
    const paint = () => {
      for (const [u0, u1, acc, side] of segs) {
        if (!acc) continue;
        const h = (acc / this.maxMargin) * half;
        const x0 = this.xOf(u0), x1 = this.xOf(u1);
        ctx.fillRect(x0, side > 0 ? mid - 0.5 - h : mid + 0.5, Math.max(1, x1 - x0 + 0.35), h);
      }
    };
    const clipped = (xa: number, xb: number, color: RGB, alpha: number) => {
      if (!(xb > xa)) return;
      ctx.save(); this.clipRect(xa, tr.y, xb, tr.y + tr.h);
      ctx.globalAlpha = alpha; ctx.fillStyle = rgba(color, 1); paint();
      ctx.restore();
    };
    this.twoPass(tr, (m) => {
      if (!sel) { clipped(L.x0, L.x1, C.ink3, 0.55 * m); return; }
      const sa = clamp(this.xOf(sel.u0), L.x0, L.x1), sb = clamp(this.xOf(sel.u1), L.x0, L.x1);
      clipped(L.x0, sa, C.ink3, 0.3 * m);
      clipped(sb, L.x1, C.ink3, 0.3 * m);
      clipped(sa, sb, C.sig, 0.6 * m);
    });
    ctx.globalAlpha = 1;
  }

  private tickSteps() {
    return [5, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080, 20160, 43200].map((minutes) => minutes * 60_000);
  }

  private drawTimeAxis() {
    const ctx = this.ctx!;
    const L = this.L;
    const C = this.C;
    const { tl } = this.data;
    const span = (this.v1 - this.v0) * tl.stepMs;
    const pxPerMs = L.pw / span;
    const ticks = this.tickSteps();
    const st = ticks.find((t) => t * pxPerMs >= 86) ?? ticks[ticks.length - 1]!;
    const tA = tOfU(tl, this.v0), tB = tOfU(tl, this.v1);
    const off = -new Date(tA).getTimezoneOffset() * 60_000;
    let t = Math.ceil((tA + off) / st) * st - off;
    ctx.font = `10px ${C.fNum}`; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.fillStyle = C.hair; ctx.fillRect(0, L.axisY + 0.5, this.W, 1);
    const xp = this.xOf(this.p);
    for (; t <= tB; t += st) {
      const x = Math.round(this.xOf(uOfT(tl, t))) + 0.5;
      if (x < L.x0 + 2 || x > L.x1 - 2) continue;
      ctx.fillStyle = C.hair; ctx.fillRect(x - 0.5, 0, 1, L.axisY);
      if (Math.abs(x - xp) < 70 || (this.hx != null && !this.dragging && Math.abs(x - this.hx) < 70)) continue;
      const midnight = (t + off) % 86_400_000 === 0;
      ctx.fillStyle = rgba(midnight ? C.ink2 : C.ink4, 1);
      ctx.fillText(midnight || st >= 86_400_000 ? fD(t) : fHM(t), x, L.axisY + AX / 2 + 1);
    }
  }

  private drawPreload() {
    const ctx = this.ctx!;
    const L = this.L;
    const C = this.C;
    const PRE = this.data.tl.preloadBars;
    if (!PRE) return;
    const xa = this.xOf(0), xb = this.xOf(PRE);
    if (xb <= L.x0) return;
    const x0 = Math.max(L.x0, xa), x1 = Math.min(L.x1, xb);
    if (x1 > x0 && this.hatch) {
      ctx.save(); ctx.fillStyle = this.hatch; ctx.fillRect(x0, 0, x1 - x0, L.axisY); ctx.restore();
    }
    if (xb >= L.x0 && xb <= L.x1) { ctx.fillStyle = C.hair3; ctx.fillRect(Math.round(xb) - 0.5, 0, 1, L.axisY); }
    const w = x1 - x0;
    if (w > 64) {
      ctx.font = `600 10px ${C.fUi}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = rgba(C.ink2, 1);
      const tx = x0 + 8;
      ctx.fillText(w > 100 ? this.copy.preloadBars(NF0.format(PRE)) : this.copy.preload, tx, L.price.py + L.price.ph - 22);
      ctx.font = `10px ${C.fUi}`; ctx.fillStyle = rgba(C.ink3, 1);
      ctx.fillText(w > 190 ? this.copy.preloadNote : this.copy.preloadShort, tx, L.price.py + L.price.ph - 8);
      ctx.fillStyle = rgba(C.ink4, 1);
      ctx.fillText(this.copy.noEquityRecord, tx, L.eq.py + L.eq.ph / 2 + 3);
    }
  }

  private drawSelSpan() {
    const g = this.sel;
    if (!g) return;
    const ctx = this.ctx!;
    const L = this.L;
    const xa = this.xOf(g.u0), xb = this.xOf(g.u1);
    if (xb < L.x0 || xa > L.x1) return;
    ctx.save(); this.clipRect(L.x0, 0, L.x1, L.axisY);
    ctx.fillStyle = rgba(this.C.sig, 0.06); ctx.fillRect(xa, 0, xb - xa, L.axisY);
    ctx.fillStyle = rgba(this.C.sig, 0.35); ctx.fillRect(Math.round(xa) - 0.5, 0, 1, L.axisY); ctx.fillRect(Math.round(xb) - 0.5, 0, 1, L.axisY);
    ctx.restore();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx!;
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  private axisTag(x: number, text: string, bg: string, fg: string) {
    const ctx = this.ctx!;
    const L = this.L;
    ctx.font = `600 10px ${this.C.fNum}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width + 12;
    const cx = clamp(x, L.x0 + w / 2, this.W - w / 2 - 2);
    ctx.fillStyle = bg; this.roundRect(cx - w / 2, L.axisY + 3, w, AX - 6, 3); ctx.fill();
    ctx.fillStyle = fg; ctx.fillText(text, cx, L.axisY + AX / 2 + 0.5);
  }

  private drawHover() {
    if (this.hx == null || this.dragging) return;
    const ctx = this.ctx!;
    const x = Math.round(this.hx) + 0.5;
    ctx.fillStyle = this.C.hair3; ctx.fillRect(x - 0.5, 0, 1, this.L.axisY);
    const u = this.uOf(this.hx);
    this.axisTag(x, fT(tOfU(this.data.tl, Math.floor(u))), rgba(this.C.s3, 1), rgba(this.C.ink, 1));
  }

  /** 播放头：全页唯一发光元素。 */
  private drawPlayhead() {
    const ctx = this.ctx!;
    const L = this.L;
    const C = this.C;
    const { bars, tl, equity } = this.data;
    const x = this.xOf(this.p);
    if (x < L.x0 - 1 || x > L.x1 + 1) return;
    const xs = Math.round(x) + 0.5;
    ctx.save();
    ctx.shadowColor = rgba(C.sig, 0.85); ctx.shadowBlur = this.reduced ? 0 : 10;
    ctx.fillStyle = rgba(C.sig, 1);
    ctx.fillRect(xs - 0.75, 0, 1.5, L.axisY);
    const i = Math.floor(this.p) - 1;
    const k = seriesIndexAtOrBefore(equity, Math.floor(this.p));
    if (this.eqScale && k >= 0 && !this.data.equityArchived && i >= tl.preloadBars) {
      ctx.beginPath(); ctx.arc(x, this.eqScale.y(equity.equity[k]!), 3.2, 0, 7); ctx.fill();
    }
    const hasBar = i >= 0 && bars.has(i);
    if (this.priceScale && hasBar) { ctx.beginPath(); ctx.arc(x, this.priceScale.y(bars.close[i]!), 3.2, 0, 7); ctx.fill(); }
    ctx.restore();
    this.axisTag(x, fT(tOfU(tl, Math.floor(this.p))), rgba(C.sig, 1), rgba(C.bg, 1));
    if (this.priceScale && hasBar) {
      const v = bars.close[i]!, yy = this.priceScale.y(v);
      if (yy >= L.price.py - 8 && yy <= L.price.py + L.price.ph + 8) {
        ctx.font = `600 10px ${C.fNum}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillStyle = rgba(C.sig, 1); this.roundRect(L.x1 + 3, yy - 8, GUT - 6, 16, 3); ctx.fill();
        ctx.fillStyle = rgba(C.bg, 1); ctx.fillText(priceFmt(v), L.x1 + 7, yy + 0.5);
      }
    }
  }

  private drawBrush() {
    const d = this.drag;
    if (!d || d.mode !== "brush") return;
    const ctx = this.ctx!;
    const a = Math.min(d.x0, d.x1), b = Math.max(d.x0, d.x1);
    ctx.fillStyle = rgba(this.C.sig, 0.1); ctx.fillRect(a, 0, b - a, this.L.axisY);
    ctx.fillStyle = rgba(this.C.sig, 0.8); ctx.fillRect(Math.round(a), 0, 1, this.L.axisY); ctx.fillRect(Math.round(b), 0, 1, this.L.axisY);
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx || this.W < 20 || this.H < 60) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    TRACK_IDS.forEach((id, k) => { if (k) { ctx.fillStyle = this.C.hair2; ctx.fillRect(0, this.L[id].y, this.W, 1); } });
    this.drawTimeAxis();
    this.drawSelSpan();
    this.drawPreload();
    this.drawPrice();
    this.drawRibbon();
    this.drawEquity();
    this.drawDD();
    this.drawExposure();
    ctx.fillStyle = this.C.hair; ctx.fillRect(this.L.x1 + 0.5, 0, 1, this.L.axisY);
    this.drawHover();
    this.drawPlayhead();
    this.drawBrush();
    this.drawNav();
    this.updateReadouts();
    this.host.zoomN.textContent = NF0.format(Math.round(this.v1 - this.v0));
    this.dirty = false;
  }

  // ============================================================
  // 读数 / HUD / 时钟
  // ============================================================
  private snapshotAtBar(i: number): SystematicReplaySnapshot | null {
    const { snapshots, tl, cover } = this.data;
    if (i < tl.preloadBars || !cover.contains(i + 0.5)) return null;
    const idx = snapshotIndexAtOrBefore(snapshots, tOfU(tl, i + 1));
    return idx >= 0 ? snapshots[idx]! : null;
  }

  private equityAtBar(i: number) {
    const eq = this.data.equity;
    const k = seriesIndexAtOrBefore(eq, i + 1);
    if (k < 0) return null;
    return { point: eq.points[k]!, hwm: eq.hwm[k]!, dd: eq.dd[k]!, exact: Math.abs(eq.u[k]! - (i + 1)) < 1e-6 };
  }

  private updateReadouts() {
    const { tl, bars, rounds } = this.data;
    const N = tl.totalBars;
    const hovering = this.hx != null && !this.dragging;
    const i = hovering ? clamp(Math.floor(this.uOf(this.hx!)), 0, N - 1) : clamp(Math.floor(this.p) - 1, 0, N - 1);
    const key = `${i}:${hovering}:${bars.has(i)}:${this.data.snapshots.length}:${this.data.equity.count}`;
    if (key === this.lastReadKey) return;
    this.lastReadKey = key;
    const c = this.copy;
    const L = this.labelEls;
    if (L.price) {
      const t = tOfU(tl, i);
      L.price.rd.innerHTML = bars.has(i)
        ? `${hovering ? "" : esc(c.playheadPrefix)}${fT(t)} · ${c.o} <em>${priceFmt(bars.open[i]!)}</em> ${c.h} <em>${priceFmt(bars.high[i]!)}</em> ${c.l} <em>${priceFmt(bars.low[i]!)}</em> ${c.c} <em>${priceFmt(bars.close[i]!)}</em>`
        : `${hovering ? "" : esc(c.playheadPrefix)}${fT(t)}${i >= tl.preloadBars ? ` · ${esc(c.notLoaded)}` : ""}`;
    }
    const u = i + 0.5;
    const g = rounds.find((round) => u >= round.u0 && u <= round.u1);
    if (L.rib) {
      L.rib.rd.innerHTML = g
        ? `<em>#${pad(g.id)}</em> ${esc(g.side === "short" ? c.short : c.long)} · <span class="${pnlCls(g.net)}">${s2(g.net)}</span>`
        : esc(i < tl.preloadBars ? c.preload : c.flat);
    }
    if (i < tl.preloadBars) {
      for (const id of ["eq", "dd", "ex"] as const) if (L[id]) L[id]!.rd.textContent = c.preloadNoRecord;
      return;
    }
    const e = this.equityAtBar(i);
    if (L.eq) L.eq.rd.innerHTML = e && !this.data.equityArchived ? `<em>${e.exact ? "" : "≈"}${f2(e.point.equityUsdt)}</em> · ${esc(c.highWater)} ${f2(e.hwm)}` : "—";
    if (L.dd) L.dd.rd.innerHTML = e && !this.data.equityArchived ? `<em class="${e.dd < 0 ? "is-neg" : ""}">${pct(e.dd)}</em>` : "—";
    if (L.ex) {
      const s = this.snapshotAtBar(i);
      if (!this.data.hasSnapshotRecords) L.ex.rd.textContent = c.noSnapshots;
      else if (!s) L.ex.rd.textContent = c.notLoaded;
      else {
        const equity = e?.exact ? e.point.equityUsdt : s.equityUsdt;
        const used = s.position ? s.usedMarginUsdt : 0;
        L.ex.rd.innerHTML = s.position
          ? `${esc(s.position.side === "short" ? c.short : c.long)} <em>${f2(used)}</em> · ${esc(c.available)} ${f2(Math.max(0, equity - used))}`
          : `<em>0.00</em> · ${esc(c.available)} ${f2(equity)}`;
      }
    }
    const partial = this.data.cover.coveredLength() < tl.evalBars - 0.5;
    const sub = !this.data.hasSnapshotRecords ? c.noSnapshots : partial ? `${c.marginSub} · ${c.marginPartial}` : c.marginSub;
    if (L.ex && L.ex.sub.textContent !== sub) L.ex.sub.textContent = sub;
  }

  private lastEvent(): TheaterEvent | null {
    const events = this.data.events;
    for (let k = events.length - 1; k >= 0; k--) if (events[k]!.u <= this.p + 1e-9) return events[k]!;
    return null;
  }

  updateHud(force = false) {
    const { tl } = this.data;
    const i = Math.floor(this.p) - 1;
    const la = this.lastEvent();
    const key = `${i}:${this.data.snapshots.length}:${this.data.equity.count}:${la ? la.u : -1}`;
    if (!force && key === this.lastHudKey) return;
    this.lastHudKey = key;
    const c = this.copy;
    const INIT = this.data.initialEquity;
    const t = tOfU(tl, Math.floor(this.p));
    const inEval = i >= tl.preloadBars;
    const s = inEval ? this.snapshotAtBar(i) : null;
    const e = inEval ? this.equityAtBar(i) : null;
    const exactEq = e && e.exact ? e.point : null;
    const eq = exactEq ? exactEq.equityUsdt : s && s.timeMs === tOfU(tl, i + 1) ? s.equityUsdt : e ? e.point.equityUsdt : INIT;
    const cash = exactEq ? exactEq.realizedCashUsdt : s && s.timeMs === tOfU(tl, i + 1) ? s.cashUsdt : e ? e.point.realizedCashUsdt : INIT;
    const un = exactEq ? exactEq.unrealizedPnlUsdt : s && s.timeMs === tOfU(tl, i + 1) ? s.unrealizedPnlUsdt : e ? e.point.unrealizedPnlUsdt : 0;
    const approx = inEval && !exactEq && !(s && s.timeMs === tOfU(tl, i + 1)) ? "≈" : "";
    const p = s?.position ?? null;
    const unknownPos = inEval && !s && this.data.hasSnapshotRecords;
    const posHtml = p
      ? `<span class="rt-hud__side">${esc(p.side === "short" ? c.short : c.long)}</span><span class="rt-num">${qtyFmt(p.quantity)}${esc(c.contracts)} @ ${priceFmt(p.averageEntryPrice)}</span>`
      : `<span class="rt-hud__flat">${esc(unknownPos ? c.notLoaded : c.flat)}</span>`;
    let laHtml = `<span>${esc(c.hudNoAction)}</span>`;
    let laTitle = "";
    if (la) {
      if (la.type === "action") {
        laHtml = `<b>${esc(c.kind(la.action.action))}</b><span data-i18n-skip>${esc(la.action.action.reason || "")}</span>`;
        laTitle = la.action.action.reason || "";
      } else {
        laHtml = `<b>${esc(c.reason(la.fill.reason))}</b><span>${esc(la.fill.side === "buy" ? c.buy : c.sell)} ${qtyFmt(la.fill.quantity)}${esc(c.contracts)} @ ${priceFmt(la.fill.fillPrice)}</span>`;
      }
    }
    const stop = p?.stopLoss;
    this.host.hud.innerHTML = `
      <div class="rt-hud__it is-time"><span>${esc(c.hudTime)}</span><span class="rt-num">${fT(t)}</span></div>
      <div class="rt-hud__it"><span>${esc(c.hudPosition)}</span>${posHtml}</div>
      <div class="rt-hud__it"><span>${esc(c.hudUnrealized)}</span><span class="rt-num ${un ? pnlCls(un) : "is-dim"}">${approx}${s2(un)}</span></div>
      <div class="rt-hud__it"><span>${esc(c.hudEquity)}</span><span class="rt-num">${approx}${f2(eq)}</span></div>
      <div class="rt-hud__it is-cash"><span>${esc(c.hudCash)}</span><span class="rt-num">${approx}${f2(cash)}</span></div>
      <div class="rt-hud__it is-stop"><span>${esc(c.hudStop)}</span><span class="rt-num ${stop ? "" : "is-faint"}">${stop ? priceFmt(stop) : "—"}</span></div>
      <div class="rt-hud__last" title="${esc(laTitle)}">${la ? `<span class="rt-hud__when">${fT(tOfU(tl, la.u))}</span>` : ""}${laHtml}</div>`;
  }

  updateClock() {
    const { tl } = this.data;
    const e = clamp(Math.floor(this.p) - tl.preloadBars, 0, tl.evalBars);
    this.host.clockD.textContent = fT(tOfU(tl, Math.floor(this.p)));
    this.host.clockS.textContent = this.copy.evalBars(NF0.format(e), NF0.format(tl.evalBars));
    this.host.zoomN.textContent = NF0.format(Math.round(this.v1 - this.v0));
    const btn = this.host.play;
    btn.innerHTML = this.playing ? PAUSE_ICON : PLAY_ICON;
    btn.classList.toggle("is-on", this.playing);
    const label = this.playing ? this.copy.pause : this.p >= tl.totalBars ? this.copy.replayFromStart : this.copy.play;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", this.playing ? "true" : "false");
  }

  // ============================================================
  // 概览导航（刷选缩放）
  // ============================================================
  private nx = (u: number) => (u / Math.max(1, this.data.tl.totalBars)) * this.NW;

  private drawNav() {
    const g = this.nctx;
    if (!g) return;
    const C = this.C;
    const { tl, equity, rounds } = this.data;
    const N = tl.totalBars;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.NW, this.NH);
    g.fillStyle = rgba(C.bg, 1); g.fillRect(0, 0, this.NW, this.NH);
    if (this.hatch && tl.preloadBars) { g.save(); g.fillStyle = this.hatch; g.fillRect(0, 0, this.nx(tl.preloadBars), this.NH); g.restore(); }
    if (equity.count && !this.data.equityArchived) {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < equity.count; k++) { lo = Math.min(lo, equity.equity[k]!); hi = Math.max(hi, equity.equity[k]!); }
      lo = Math.min(lo, this.data.initialEquity); hi = Math.max(hi, this.data.initialEquity);
      const span = hi - lo || 1;
      const yy = (v: number) => 4 + (1 - (v - lo) / span) * (this.NH - 14);
      g.beginPath(); g.moveTo(this.nx(tl.preloadBars), yy(this.data.initialEquity));
      const stride = Math.max(1, Math.floor(equity.count / (this.NW * 2)));
      for (let k = 0; k < equity.count; k += stride) g.lineTo(this.nx(equity.u[k]!), yy(equity.equity[k]!));
      g.lineTo(this.nx(equity.u[equity.count - 1]!), yy(equity.equity[equity.count - 1]!));
      g.strokeStyle = rgba(C.ink3, 0.9); g.lineWidth = 1; g.stroke();
    }
    for (const t of rounds) {
      g.fillStyle = rgba(this.pnlRGB(t.net), t === this.sel ? 1 : 0.75);
      g.fillRect(this.nx(t.u0), this.NH - 5, Math.max(1.5, this.nx(t.u1) - this.nx(t.u0)), 3);
    }
    const a = this.nx(this.v0), b = this.nx(this.v1);
    g.fillStyle = rgba(C.bg, 0.62);
    g.fillRect(0, 0, a, this.NH); g.fillRect(b, 0, this.NW - b, this.NH);
    g.strokeStyle = C.hair3; g.lineWidth = 1;
    g.strokeRect(a + 0.5, 0.5, Math.max(2, b - a - 1), this.NH - 1);
    g.fillStyle = rgba(C.ink3, 1);
    g.fillRect(a + 0.5, this.NH / 2 - 6, 2, 12); g.fillRect(b - 2.5, this.NH / 2 - 6, 2, 12);
    // 播放头位置（不发光：光只属于主播放头）
    g.fillStyle = rgba(C.sig, 1); g.fillRect(Math.round(this.nx(Math.min(this.p, N))) - 0.5, 0, 1.5, this.NH);
  }

  // ============================================================
  // 视图操作
  // ============================================================
  setView(v0: number, v1: number, animate = false) {
    const N = Math.max(MIN_SPAN, this.data.tl.totalBars);
    const span = clamp(v1 - v0, MIN_SPAN, N);
    let a = v0, b = v0 + span;
    if (a < 0) { a = 0; b = span; }
    if (b > N) { b = N; a = N - span; }
    if (animate && !this.reduced) this.viewAnim = { from: [this.v0, this.v1], to: [a, b], t: 0 };
    else { this.v0 = a; this.v1 = b; this.viewAnim = null; }
    this.dirty = true;
  }

  private zoomAt(u: number, factor: number) {
    const N = Math.max(MIN_SPAN, this.data.tl.totalBars);
    const span = clamp((this.v1 - this.v0) * factor, MIN_SPAN, N);
    const k = (u - this.v0) / (this.v1 - this.v0);
    this.setView(u - k * span, u - k * span + span);
  }

  private ensureVisible(u0: number, u1: number) {
    const span = this.v1 - this.v0;
    if (u0 >= this.v0 + span * 0.04 && u1 <= this.v1 - span * 0.04) return;
    const need = (u1 - u0) * 1.6;
    if (need > span) this.setView(u0 - (u1 - u0) * 0.3, u1 + (u1 - u0) * 0.3, true);
    else { const c = (u0 + u1) / 2; this.setView(c - span / 2, c + span / 2, true); }
  }

  fitAll() { this.setView(0, this.data.tl.totalBars, true); }

  // ============================================================
  // 播放 / 事件浮字
  // ============================================================
  private spawnFloat(ev: TheaterEvent) {
    if (this.reduced) return;
    const el = document.createElement("div");
    let cls = "rt-float";
    const c = this.copy;
    if (ev.type === "action") {
      const a = ev.action.action;
      if (a.kind === "set_protection" || a.kind === "cancel_protection") cls += " is-quiet";
      el.innerHTML = `<b>${esc(c.kind(a))}</b><span data-i18n-skip>${esc(a.reason || "")}</span>`;
    } else {
      cls += " is-engine";
      const net = ev.trade ? ev.trade.netPnlUsdt : 0;
      el.innerHTML = `<b>${esc(c.reason(ev.fill.reason))}</b>${qtyFmt(ev.fill.quantity)}${esc(c.contracts)} @ ${priceFmt(ev.fill.fillPrice)} · <span class="${pnlCls(net)}">${s2(net)}</span>`;
    }
    el.className = cls;
    const dur = this.speed >= 1024 ? 900 : this.speed >= 256 ? 1400 : this.speed >= 64 ? 2000 : 2800;
    el.style.setProperty("--dur", `${dur}ms`);
    const used = new Set(this.live.map((f) => f.slot));
    let slot = 0;
    while (used.has(slot) && slot < 3) slot++;
    if (slot >= 3) {
      const old = this.live.shift();
      if (old) { window.clearTimeout(old.timer); old.el.remove(); slot = old.slot; }
    }
    this.host.floats.append(el);
    const f: LiveFloat = { el, u: ev.u, slot, w: el.offsetWidth, timer: 0 };
    f.timer = window.setTimeout(() => { el.remove(); const k = this.live.indexOf(f); if (k >= 0) this.live.splice(k, 1); }, dur);
    this.live.push(f);
    this.placeFloat(f);
  }

  private placeFloat(f: LiveFloat) {
    const x = this.xOf(f.u);
    const flip = x + 12 + f.w > this.L.x1 - 4;
    f.el.classList.toggle("is-flip", flip);
    f.el.style.left = `${flip ? x - 10 - f.w : x + 10}px`;
    f.el.style.top = `${this.L.price.py + 34 + f.slot * 44}px`;
    f.el.style.visibility = x < this.L.x0 - 20 || x > this.L.x1 + 20 ? "hidden" : "visible";
  }

  private emitBetween(a: number, b: number) {
    if (b <= a) return;
    // 高速（≥256 根/秒）时一帧可能跨过大量动作：只浮出这一段里最新的一条，避免浮字刷屏。
    if (this.speed >= 256) {
      let latest: (typeof this.data.events)[number] | null = null;
      for (const ev of this.data.events) if (ev.u > a && ev.u <= b + 1e-9) latest = ev;
      if (latest) this.spawnFloat(latest);
      return;
    }
    let n = 0;
    for (const ev of this.data.events) {
      if (ev.u > a && ev.u <= b + 1e-9) { this.spawnFloat(ev); if (++n > 3) break; }
    }
  }

  setPlaying(on: boolean) {
    const { tl } = this.data;
    if (on && this.p >= tl.totalBars - 1e-6) this.p = tl.preloadBars;
    this.playing = on;
    if (!on) this.stopAt = null;
    this.updateClock();
    this.dirty = true;
    this.cb.onPlayingChange(on);
  }

  togglePlay() { this.setPlaying(!this.playing); }

  setSpeed(speed: number) { this.speed = speed; }

  seek(p: number, emit = false) {
    const { tl } = this.data;
    const prev = this.p;
    this.p = clamp(p, tl.preloadBars, tl.totalBars);
    if (emit) this.emitBetween(prev, this.p);
    this.updateHud();
    this.updateClock();
    this.updateListTime();
    this.dirty = true;
  }

  private follow() {
    const span = this.v1 - this.v0;
    if (span >= this.data.tl.totalBars - 0.5) return;
    if (this.p > this.v1 - span * 0.06) this.setView(this.p - span * 0.3, this.p + span * 0.7);
    else if (this.p < this.v0) this.setView(this.p - span * 0.3, this.p + span * 0.7);
  }

  stepBar(d: number) {
    if (this.playing) this.setPlaying(false);
    this.seek(Math.floor(this.p) + d, true);
    this.follow();
  }

  jumpAct(d: number) {
    if (this.playing) this.setPlaying(false);
    const events = this.data.events;
    const ev = d > 0 ? events.find((e) => e.u > this.p + 1e-6) : [...events].reverse().find((e) => e.u < this.p - 1e-6);
    if (ev) {
      this.seek(Math.ceil(ev.u));
      if (ev.u <= this.p) this.spawnFloat(ev);
      this.follow();
    }
  }

  home() { if (this.playing) this.setPlaying(false); this.seek(this.data.tl.preloadBars); this.follow(); }
  end() { if (this.playing) this.setPlaying(false); this.seek(this.data.tl.totalBars); this.follow(); }

  // ============================================================
  // 选择 / 列表
  // ============================================================
  select(round: TheaterRound | null, frame = false) {
    this.sel = round;
    if (round && frame) this.ensureVisible(round.u0, round.u1);
    this.syncListState();
    if (round) this.revealRow(round.id);
    this.dirty = true;
    this.cb.onSelect(round);
  }

  /** Keeps the selected row visible inside the list without scrolling any outer container. */
  revealRow(id: number) {
    const el = this.rowEls.get(id);
    const list = this.host.list;
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = Math.max(0, top - el.offsetHeight * 2);
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + el.offsetHeight * 2;
  }

  stepRound(d: number) {
    const rounds = this.data.rounds;
    if (!rounds.length) return;
    const k = this.sel ? rounds.indexOf(this.sel) : d > 0 ? -1 : rounds.length;
    this.select(rounds[clamp(k + d, 0, rounds.length - 1)]!, true);
  }

  replayRound(round: TheaterRound) {
    const { tl } = this.data;
    this.sel = round;
    this.syncListState();
    this.cb.onSelect(round);
    const span = Math.max(MIN_SPAN * 2, (round.u1 - round.u0) * 1.8);
    this.setView(round.u0 - span * 0.2, round.u0 - span * 0.2 + span, true);
    this.p = Math.max(tl.preloadBars, Math.floor(round.u0) - 6);
    this.stopAt = Math.min(tl.totalBars, Math.ceil(round.u1) + 4);
    this.playing = true;
    this.cb.onPlayingChange(true);
    this.updateHud(true); this.updateClock(); this.updateListTime(true);
    this.dirty = true;
  }

  jumpToRound(round: TheaterRound) {
    if (this.playing) this.setPlaying(false);
    this.seek(round.u0);
    this.ensureVisible(round.u0, round.u1);
  }

  seekTo(u: number) {
    if (this.playing) this.setPlaying(false);
    this.seek(u);
  }

  /** Called by React after the trade list re-renders (filter change). */
  bindRows() {
    this.rowEls = new Map();
    this.host.list.querySelectorAll<HTMLElement>("[data-round]").forEach((el) => {
      this.rowEls.set(Number(el.dataset.round), el);
    });
    this.syncListState();
    this.updateListTime(true);
  }

  private syncListState() {
    this.rowEls.forEach((el, id) => {
      const isSel = this.sel?.id === id;
      el.classList.toggle("is-sel", isSel);
      el.classList.toggle("is-hover", this.hover?.id === id && !isSel);
      el.setAttribute("aria-selected", isSel ? "true" : "false");
    });
  }

  setHoverById(id: number | null) {
    const round = id == null ? null : this.data.rounds.find((item) => item.id === id) ?? null;
    if (round === this.hover) return;
    this.hover = round;
    this.dirty = true;
  }

  private updateListTime(force = false) {
    const p = Math.floor(this.p);
    if (p === this.lastListP && !force) return;
    this.lastListP = p;
    const byId = new Map(this.data.rounds.map((round) => [round.id, round]));
    this.rowEls.forEach((el, id) => {
      const g = byId.get(id);
      if (!g) return;
      el.classList.toggle("is-future", g.u0 > this.p);
      el.classList.toggle("is-open", g.u0 <= this.p && g.u1 > this.p);
    });
  }

  // ============================================================
  // 交互
  // ============================================================
  private tripAt(x: number, y: number): TheaterRound | null {
    const L = this.L;
    const u = this.uOf(x);
    const tol = ((this.v1 - this.v0) / L.pw) * 4;
    const { rounds, tl } = this.data;
    if (y >= L.rib.y && y < L.rib.y + L.rib.h) return rounds.find((g) => u >= g.u0 - tol && u <= g.u1 + tol) ?? null;
    if (y >= L.price.py && y < L.price.py + L.price.ph && this.priceScale) {
      for (const g of rounds) {
        if (g.u1 < this.v0 - 2 || g.u0 > this.v1 + 2) continue;
        const pts: Array<[number, number]> = [[g.u0, g.fills[0] ? g.fills[0].fillPrice : g.entryPrice], ...g.closes.map((c) => [uOfT(tl, c.exitTimeMs), c.exitPrice] as [number, number])];
        for (const [pu, pv] of pts) if (Math.hypot(this.xOf(pu) - x, this.priceScale.y(pv) - y) < 8) return g;
      }
    }
    return null;
  }

  private showTip(g: TheaterRound | null, x = 0, y = 0) {
    const tip = this.host.tip;
    if (!g) { tip.classList.remove("is-on"); return; }
    const c = this.copy;
    tip.innerHTML = `<div class="rt-tip__t1"><b>#${pad(g.id)} ${esc(g.side === "short" ? c.short : c.long)} ${qtyFmt(g.qty0)}${esc(c.contracts)}</b><span class="rt-num ${pnlCls(g.net)}">${s2(g.net)} USDT</span></div><div class="rt-tip__t2 rt-num">${fT(g.entryTimeMs)} → ${fT(g.exitTimeMs)} · ${esc(c.duration(g.exitTimeMs - g.entryTimeMs))} · ${esc(g.closes.map((close) => c.reason(close.exitReason)).join(" / "))}</div>`;
    tip.classList.add("is-on");
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${clamp(x + 14, 4, this.W - tw - 4)}px`;
    tip.style.top = `${clamp(y - th - 10, 4, this.H - th - 4)}px`;
  }

  private on<K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) {
    el.addEventListener(type, fn as EventListener, opts);
    this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  private bind() {
    const cv = this.host.canvas;
    const tracks = this.host.tracks;
    const pos = (e: PointerEvent | WheelEvent | MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    this.on(cv, "pointerdown", (e) => {
      const { x, y } = pos(e);
      if (x > this.L.x1 || y > this.L.axisY) return;
      cv.setPointerCapture?.(e.pointerId);
      if (e.shiftKey) { this.drag = { mode: "brush", x0: x, x1: x }; tracks.classList.add("is-brush"); return; }
      const g = this.tripAt(x, y);
      if (g) { this.drag = { mode: "band", round: g, x0: x }; return; }
      this.drag = { mode: "scrub" };
      this.dragging = true;
      if (this.playing) this.setPlaying(false);
      tracks.classList.add("is-scrub");
      this.seek(Math.round(this.uOf(x)));
    });
    this.on(cv, "pointermove", (e) => {
      const { x, y } = pos(e);
      const d = this.drag;
      if (d) {
        if (d.mode === "scrub") { this.seek(Math.round(this.uOf(clamp(x, this.L.x0, this.L.x1)))); this.hx = x; }
        else if (d.mode === "brush") { d.x1 = clamp(x, this.L.x0, this.L.x1); this.dirty = true; }
        return;
      }
      const inPlot = x >= this.L.x0 && x <= this.L.x1 && y < this.L.axisY;
      this.hx = inPlot ? x : null;
      const g = inPlot ? this.tripAt(x, y) : null;
      if (g !== this.hover) { this.hover = g; this.syncListState(); }
      tracks.classList.toggle("is-band", Boolean(g));
      this.showTip(g, x, y);
      this.dirty = true;
    });
    const up = () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.dragging = false;
      tracks.classList.remove("is-scrub", "is-brush");
      if (d.mode === "band") this.select(this.sel === d.round ? null : d.round, false);
      if (d.mode === "brush" && Math.abs(d.x1 - d.x0) > 6) {
        this.setView(this.uOf(Math.min(d.x0, d.x1)), this.uOf(Math.max(d.x0, d.x1)), true);
      }
      this.dirty = true;
    };
    this.on(cv, "pointerup", up);
    this.on(cv, "pointercancel", up);
    this.on(cv, "pointerleave", () => {
      if (this.drag) return;
      this.hx = null; this.hover = null; this.syncListState(); this.showTip(null);
      tracks.classList.remove("is-band");
      this.dirty = true;
    });
    this.on(cv, "dblclick", () => this.fitAll());
    this.on(cv, "wheel", (e) => {
      e.preventDefault();
      const x = clamp(pos(e).x, this.L.x0, this.L.x1);
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        const d = ((e.shiftKey ? e.deltaY : e.deltaX) / this.L.pw) * (this.v1 - this.v0);
        this.setView(this.v0 + d, this.v1 + d);
      } else {
        this.zoomAt(this.uOf(x), Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
      }
    }, { passive: false });

    // 概览导航
    const nav = this.host.nav;
    const nxToU = (x: number) => clamp((x / this.NW) * this.data.tl.totalBars, 0, this.data.tl.totalBars);
    this.on(nav, "pointerdown", (e) => {
      const x = e.clientX - nav.getBoundingClientRect().left;
      const a = this.nx(this.v0), b = this.nx(this.v1);
      nav.setPointerCapture?.(e.pointerId);
      nav.classList.add("is-drag");
      if (Math.abs(x - a) < 6) this.ndrag = { mode: "l" };
      else if (Math.abs(x - b) < 6) this.ndrag = { mode: "r" };
      else if (x > a && x < b) this.ndrag = { mode: "pan", x0: x, v0: this.v0, v1: this.v1 };
      else this.ndrag = { mode: "new", x0: x };
    });
    this.on(nav, "pointermove", (e) => {
      const x = e.clientX - nav.getBoundingClientRect().left;
      const u = nxToU(x);
      const d = this.ndrag;
      if (!d) {
        const a = this.nx(this.v0), b = this.nx(this.v1);
        nav.style.cursor = Math.abs(x - a) < 6 || Math.abs(x - b) < 6 ? "ew-resize" : x > a && x < b ? "grab" : "crosshair";
        return;
      }
      if (d.mode === "l") this.setView(Math.min(u, this.v1 - MIN_SPAN), this.v1);
      else if (d.mode === "r") this.setView(this.v0, Math.max(u, this.v0 + MIN_SPAN));
      else if (d.mode === "pan") { const dd = ((x - d.x0) / this.NW) * this.data.tl.totalBars; this.setView(d.v0 + dd, d.v1 + dd); }
      else { const u0 = nxToU(d.x0); if (Math.abs(u - u0) > 2) this.setView(Math.min(u, u0), Math.max(u, u0)); }
    });
    const navUp = (e: PointerEvent) => {
      const d = this.ndrag;
      if (d && d.mode === "new") {
        const x = e.clientX - nav.getBoundingClientRect().left;
        if (Math.abs(x - d.x0) < 3) { const u = nxToU(x), span = this.v1 - this.v0; this.setView(u - span / 2, u + span / 2, true); }
      }
      this.ndrag = null;
      nav.classList.remove("is-drag");
    };
    this.on(nav, "pointerup", navUp);
    this.on(nav, "pointercancel", navUp);

    // 键盘：只在焦点位于剧场内或页面主体时响应，避免抢占其它面板的按键
    this.on(window, "keydown", (e) => {
      const root = this.host.root;
      if (!root.isConnected || root.offsetParent === null) return;
      const active = document.activeElement;
      const inTheater = active instanceof Node && root.contains(active);
      if (!inTheater && active && active !== document.body) return;
      if (active instanceof HTMLElement && (/^(input|textarea|select)$/i.test(active.tagName) || active.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const buttonFocused = active instanceof HTMLButtonElement;
      if (e.key === " ") { if (buttonFocused) return; e.preventDefault(); this.togglePlay(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); if (e.shiftKey) this.jumpAct(1); else this.stepBar(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); if (e.shiftKey) this.jumpAct(-1); else this.stepBar(-1); }
      else if (e.key === "]") this.stepRound(1);
      else if (e.key === "[") this.stepRound(-1);
      else if (e.key === "Escape") { if (this.sel) this.select(null); }
      else if (e.key === "0") this.fitAll();
      else if (e.key === "=" || e.key === "+") this.zoomAt(this.p, 0.7);
      else if (e.key === "-") this.zoomAt(this.p, 1.4);
      else if (e.key === "Home") { e.preventDefault(); this.home(); }
      else if (e.key === "End") { e.preventDefault(); this.end(); }
    });
  }

  // ============================================================
  // 主循环
  // ============================================================
  private frame = (now: number) => {
    if (this.destroyed) return;
    const dt = this.tPrev ? Math.min(0.25, (now - this.tPrev) / 1000) : 0;
    this.tPrev = now;
    if (this.viewAnim) {
      const va = this.viewAnim;
      va.t = Math.min(1, va.t + dt / 0.32);
      const k = 1 - Math.pow(1 - va.t, 3);
      this.v0 = va.from[0] + (va.to[0] - va.from[0]) * k;
      this.v1 = va.from[1] + (va.to[1] - va.from[1]) * k;
      if (va.t >= 1) this.viewAnim = null;
      this.dirty = true;
    }
    if (this.playing) {
      const prev = this.p;
      const end = this.stopAt ?? this.data.tl.totalBars;
      const next = Math.min(end, this.p + dt * this.speed);
      this.p = next;
      this.emitBetween(prev, this.p);
      if (this.p >= end) {
        this.playing = false; this.stopAt = null; this.p = Math.round(this.p);
        this.cb.onPlayingChange(false);
        this.updateClock();
      }
      if (!this.viewAnim) this.follow();
      this.updateHud();
      this.updateListTime();
      const { tl } = this.data;
      this.host.clockD.textContent = fT(tOfU(tl, Math.floor(this.p)));
      this.host.clockS.textContent = this.copy.evalBars(NF0.format(clamp(Math.floor(this.p) - tl.preloadBars, 0, tl.evalBars)), NF0.format(tl.evalBars));
      this.dirty = true;
    }
    if (this.dirty) this.draw();
    for (const f of this.live) this.placeFloat(f);
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Debug / smoke hook. */
  debugState() {
    return { v0: this.v0, v1: this.v1, p: this.p, playing: this.playing, speed: this.speed, sel: this.sel?.id ?? null, rounds: this.data.rounds.length, loadedBars: this.data.bars.loadedCount };
  }
}

