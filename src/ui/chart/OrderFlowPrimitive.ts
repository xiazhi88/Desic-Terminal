import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time
} from "lightweight-charts";
import type { OrderBookWall } from "../../lib/orderBookWalls";
import type { DeltaPoint, Divergence, LiquidationMark } from "./orderFlowModel";

// 订单流图元（挂在 K 线序列上，与价格轴 / 时间轴同一坐标系）：
// - 底层：主动买卖差的纵向色柱与底部色带、价值区、双色成交量分布（阳线 / 阴线成交）、POC 光线；
// - 顶层：当前大单墙能量条、清算冲击波与光柱、价格与 CVD 的背离连线。
// 颜色约定与盘口一致：买 / 多 = 绿，卖 / 空 = 红；POC 与价值区用信号蓝。
// 动效只用于“活”的数据（当前大单墙、最近的清算），并遵循系统的减少动态效果设置。

export type VolumeProfileData = {
  bucket: number;
  /** `[桶下沿价格, 成交量, 阳线成交量?]`；阳 / 阴拆分是 K 线方向口径，不是逐笔主动买卖。 */
  levels: Array<[number, number, number?]>;
  poc: number | null;
  valueAreaHigh: number | null;
  valueAreaLow: number | null;
};

export type OrderFlowLabels = {
  poc: string;
  valueArea: string;
  bidWall: string;
  askWall: string;
  /** 墙已存在时长：前缀（如“已挂”）与秒 / 分 / 时单位。 */
  wallAge: string;
  seconds: string;
  minutes: string;
  hours: string;
  contracts: string;
  bearishDivergence: string;
  bullishDivergence: string;
  longLiquidated: string;
  shortLiquidated: string;
};

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type BitmapScope = Parameters<Parameters<DrawTarget["useBitmapCoordinateSpace"]>[0]>[0];
type TimeMapping = { xAt: (sec: number) => number; lastTime: number; interval: number };

const BID_RGB = "25, 217, 154";
const ASK_RGB = "255, 77, 106";
const SIGNAL_RGB = "106, 176, 236";
const INK_RGB = "220, 224, 240";
const PROFILE_WIDTH_SHARE = 0.2;
const RIBBON_HEIGHT = 5;
const FRAME_MS = 1000 / 20;
/** 墙量较观察到的峰值下降超过该比例时标注“↓N%”（可能是被成交，也可能是撤单，只描述数量变化）。 */
const WALL_DRAIN_NOTICE = 0.2;
/** 最近 N 根 K 线内的清算视为“正在发生”，画扩散的冲击波。 */
const LIVE_LIQUIDATION_BARS = 3;

function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value >= 10 ? value.toFixed(0) : value.toFixed(2);
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

export class OrderFlowPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private profile: VolumeProfileData | null = null;
  private walls: OrderBookWall[] = [];
  private wallPeaks = new Map<string, number>();
  private liquidations: LiquidationMark[] = [];
  private divergences: Divergence[] = [];
  private deltas: DeltaPoint[] = [];
  private deltaResolution = 300;
  private animationHandle: number | null = null;
  private lastFrameAt = 0;
  private readonly bottomView: IPrimitivePaneView;
  private readonly topView: IPrimitivePaneView;

  constructor(private readonly labels: OrderFlowLabels) {
    const bottom: IPrimitivePaneRenderer = { draw: (target) => target.useBitmapCoordinateSpace((scope) => this.drawBottom(scope)) };
    const top: IPrimitivePaneRenderer = { draw: (target) => target.useBitmapCoordinateSpace((scope) => this.drawTop(scope)) };
    this.bottomView = { zOrder: (): PrimitivePaneViewZOrder => "bottom", renderer: () => bottom };
    this.topView = { zOrder: (): PrimitivePaneViewZOrder => "top", renderer: () => top };
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
    this.startAnimation();
  }

  detached() {
    if (this.animationHandle !== null) window.cancelAnimationFrame(this.animationHandle);
    this.animationHandle = null;
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return [this.bottomView, this.topView];
  }

  setProfile(profile: VolumeProfileData | null) {
    this.profile = profile;
    this.requestUpdate?.();
  }

  setWalls(walls: OrderBookWall[]) {
    const keys = new Set<string>();
    for (const wall of walls) {
      const key = `${wall.side}:${wall.price}`;
      keys.add(key);
      this.wallPeaks.set(key, Math.max(this.wallPeaks.get(key) ?? 0, wall.size));
    }
    for (const key of this.wallPeaks.keys()) if (!keys.has(key)) this.wallPeaks.delete(key);
    this.walls = walls;
    this.requestUpdate?.();
  }

  setLiquidations(marks: LiquidationMark[]) {
    this.liquidations = marks;
    this.requestUpdate?.();
  }

  setDivergences(divergences: Divergence[]) {
    this.divergences = divergences;
    this.requestUpdate?.();
  }

  setDeltas(deltas: DeltaPoint[], resolution: number) {
    this.deltas = deltas;
    this.deltaResolution = resolution;
    this.requestUpdate?.();
  }

  // 只有存在“活”的图层（大单墙 / 最近清算）时才逐帧重绘，约 20fps；页面隐藏或减少动态效果时停止。
  private startAnimation() {
    if (prefersReducedMotion()) return;
    const tick = (now: number) => {
      this.animationHandle = window.requestAnimationFrame(tick);
      if (document.hidden || now - this.lastFrameAt < FRAME_MS) return;
      if (this.walls.length === 0 && !this.hasLiveLiquidation()) return;
      this.lastFrameAt = now;
      this.requestUpdate?.();
    };
    this.animationHandle = window.requestAnimationFrame(tick);
  }

  private hasLiveLiquidation() {
    const mapping = this.liquidations.length > 0 ? this.timeMapping() : null;
    if (!mapping) return false;
    const since = mapping.lastTime - mapping.interval * LIVE_LIQUIDATION_BARS;
    return this.liquidations.some((mark) => mark.time >= since);
  }

  // K 线中心 = 开盘时间：用可见区两端的真实时间做线性映射，任意秒级时间都能落到横轴上。
  private timeMapping(): TimeMapping | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return null;
    const data = series.data();
    if (data.length < 2) return null;
    const range = chart.timeScale().getVisibleLogicalRange();
    const from = Math.max(0, Math.floor(range?.from ?? 0));
    const to = Math.min(data.length - 1, Math.ceil(range?.to ?? data.length - 1));
    const left = Math.max(0, Math.min(from, data.length - 2));
    const right = Math.max(left + 1, to);
    const t0 = Number(data[left]!.time);
    const t1 = Number(data[right]!.time);
    const x0 = chart.timeScale().logicalToCoordinate(left as Logical);
    const x1 = chart.timeScale().logicalToCoordinate(right as Logical);
    if (x0 === null || x1 === null || t1 <= t0 || x1 <= x0) return null;
    const interval = (t1 - t0) / (right - left);
    const spacing = (x1 - x0) / (right - left);
    return { xAt: (sec: number) => x0 + ((sec - t0) / interval) * spacing, lastTime: Number(data[data.length - 1]!.time), interval };
  }

  private y(price: number) {
    const coordinate = this.series?.priceToCoordinate(price);
    return coordinate === null || coordinate === undefined ? null : Number(coordinate);
  }

  private drawBottom(scope: BitmapScope) {
    const { context } = scope;
    context.save();
    this.drawDeltaColumns(scope);
    this.drawProfile(scope);
    context.restore();
  }

  /** 主动买卖差：强度前 40% 的时段画一根自下而上渐隐的淡色柱，底部一条实心色带覆盖所有时段。 */
  private drawDeltaColumns({ context, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }: BitmapScope) {
    if (this.deltas.length === 0) return;
    const mapping = this.timeMapping();
    if (!mapping) return;
    const magnitudes = this.deltas.map((point) => Math.abs(point.delta)).sort((left, right) => left - right);
    const max = magnitudes.at(-1) || 1;
    const strongCut = magnitudes[Math.floor(magnitudes.length * 0.6)] ?? 0;
    const height = mediaSize.height * vpr;
    for (const point of this.deltas) {
      const x0 = mapping.xAt(point.time - mapping.interval / 2);
      const x1 = mapping.xAt(point.time + this.deltaResolution - mapping.interval / 2);
      if (x1 < 0 || x0 > mediaSize.width) continue;
      const intensity = Math.min(1, Math.abs(point.delta) / max);
      const rgb = point.delta >= 0 ? BID_RGB : ASK_RGB;
      const left = Math.round(x0 * hpr);
      const width = Math.max(1, Math.round(x1 * hpr) - left);
      if (Math.abs(point.delta) >= strongCut && intensity > 0.15) {
        const column = context.createLinearGradient(0, height, 0, 0);
        column.addColorStop(0, `rgba(${rgb}, ${0.12 * intensity})`);
        column.addColorStop(0.55, `rgba(${rgb}, ${0.03 * intensity})`);
        column.addColorStop(1, `rgba(${rgb}, 0)`);
        context.fillStyle = column;
        context.fillRect(left, 0, width, height);
      }
      context.fillStyle = `rgba(${rgb}, ${0.25 + 0.7 * intensity})`;
      context.fillRect(left, height - RIBBON_HEIGHT * vpr, Math.max(1, width - hpr), RIBBON_HEIGHT * vpr);
    }
  }

  private drawProfile({ context, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }: BitmapScope) {
    const profile = this.profile;
    if (!profile || profile.levels.length === 0 || profile.bucket <= 0) return;
    const width = mediaSize.width * hpr;
    const inValueArea = (price: number) => profile.valueAreaHigh !== null && profile.valueAreaLow !== null && price >= profile.valueAreaLow && price < profile.valueAreaHigh;
    // 价值区：信号蓝底色，上下沿为自右向左渐隐的发光细线。
    if (profile.valueAreaHigh !== null && profile.valueAreaLow !== null) {
      const top = this.y(profile.valueAreaHigh);
      const bottom = this.y(profile.valueAreaLow);
      if (top !== null && bottom !== null) {
        const band = context.createLinearGradient(0, 0, width, 0);
        band.addColorStop(0, `rgba(${SIGNAL_RGB}, 0.015)`);
        band.addColorStop(1, `rgba(${SIGNAL_RGB}, 0.07)`);
        context.fillStyle = band;
        context.fillRect(0, top * vpr, width, (bottom - top) * vpr);
        const edge = context.createLinearGradient(0, 0, width, 0);
        edge.addColorStop(0, `rgba(${SIGNAL_RGB}, 0)`);
        edge.addColorStop(1, `rgba(${SIGNAL_RGB}, 0.55)`);
        context.fillStyle = edge;
        context.fillRect(0, Math.round(top * vpr), width, Math.max(1, vpr));
        context.fillRect(0, Math.round(bottom * vpr), width, Math.max(1, vpr));
      }
    }
    // 成交量分布：阳线成交（绿）在外侧、阴线成交（红）贴右轴，外端最亮；价值区外整体压暗。
    const maxVolume = Math.max(...profile.levels.map(([, volume]) => volume));
    const barMax = mediaSize.width * PROFILE_WIDTH_SHARE;
    let pocRect: [number, number, number, number] | null = null;
    for (const [price, volume, upVolume] of profile.levels) {
      const top = this.y(price + profile.bucket);
      const bottom = this.y(price);
      if (top === null || bottom === null) continue;
      const y0 = top * vpr;
      const height = Math.max(1, (bottom - top) * vpr - Math.max(1, vpr * 0.6));
      const length = (volume / maxVolume) * barMax * hpr;
      const start = width - length;
      const isPoc = profile.poc !== null && profile.poc >= price && profile.poc < price + profile.bucket;
      if (isPoc) {
        pocRect = [start, y0, length, height];
        continue;
      }
      const dim = inValueArea(price) ? 1 : 0.45;
      const share = upVolume === undefined ? null : Math.max(0, Math.min(1, upVolume / volume));
      const segments: Array<[string, number, number]> = share === null
        ? [[INK_RGB, start, length]]
        : [[BID_RGB, start, length * share], [ASK_RGB, start + length * share, length * (1 - share)]];
      for (const [rgb, x, segment] of segments) {
        if (segment <= 0) continue;
        const fill = context.createLinearGradient(x, 0, x + segment, 0);
        fill.addColorStop(0, `rgba(${rgb}, ${0.62 * dim})`);
        fill.addColorStop(1, `rgba(${rgb}, ${0.2 * dim})`);
        context.fillStyle = fill;
        context.fillRect(x, y0, segment, height);
      }
    }
    // POC：整条信号蓝光线横贯图表（左侧渐隐），对应的分布条白热发光。
    if (profile.poc !== null) {
      const y = this.y(profile.poc);
      if (y !== null) {
        const yy = Math.round(y * vpr);
        const beam = context.createLinearGradient(0, 0, width, 0);
        beam.addColorStop(0, `rgba(${SIGNAL_RGB}, 0)`);
        beam.addColorStop(0.35, `rgba(${SIGNAL_RGB}, 0.35)`);
        beam.addColorStop(1, `rgba(${SIGNAL_RGB}, 0.95)`);
        context.save();
        context.shadowColor = `rgba(${SIGNAL_RGB}, 0.9)`;
        context.shadowBlur = 10 * hpr;
        context.fillStyle = beam;
        context.fillRect(0, yy - Math.max(1, vpr), width, Math.max(2, 1.5 * vpr));
        context.restore();
      }
    }
    if (pocRect) {
      const [x, y0, length, height] = pocRect;
      const fill = context.createLinearGradient(x, 0, x + length, 0);
      fill.addColorStop(0, "rgba(236, 246, 255, 0.95)");
      fill.addColorStop(1, `rgba(${SIGNAL_RGB}, 0.55)`);
      context.save();
      context.shadowColor = `rgba(${SIGNAL_RGB}, 0.95)`;
      context.shadowBlur = 14 * hpr;
      context.fillStyle = fill;
      context.fillRect(x, y0, length, height);
      context.restore();
    }
  }

  private drawTop(scope: BitmapScope) {
    const mapping = this.timeMapping();
    const { context } = scope;
    const phase = performance.now() / 1000;
    context.save();
    context.font = `600 ${10.5 * scope.verticalPixelRatio}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    context.textBaseline = "middle";
    this.drawProfileLabels(scope);
    this.drawWalls(scope, mapping, phase);
    if (mapping) {
      this.drawLiquidations(scope, mapping, phase);
      this.drawDivergences(scope, mapping);
    }
    context.restore();
  }

  /** 当前大单墙：从首次观察到的时刻延伸到右端的能量条，厚度随挂单量，一道高光沿墙流动。 */
  private drawWalls({ context, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }: BitmapScope, mapping: TimeMapping | null, phase: number) {
    if (this.walls.length === 0) return;
    const now = Date.now();
    const width = mediaSize.width * hpr;
    const profileLeft = mediaSize.width * (1 - PROFILE_WIDTH_SHARE);
    const maxWall = Math.max(1, ...this.walls.map((wall) => wall.size));
    const visibleWalls = this.walls
      .map((wall) => ({ wall, y: this.y(wall.price) }))
      .filter((item): item is { wall: OrderBookWall; y: number } => item.y !== null && item.y >= 0 && item.y <= mediaSize.height)
      .sort((left, right) => left.y - right.y);
    // 价位相近的墙标签自上而下错开，墙体本身仍画在真实价位。
    let lastLabelY = -Infinity;
    for (const { wall, y } of visibleWalls) {
      const rgb = wall.side === "bid" ? BID_RGB : ASK_RGB;
      // 首次出现时刻若晚于最后一根 K 线（或时钟与 K 线不同源），至少保证墙体穿过成交分布区可见。
      const startX = (mapping ? Math.min(Math.max(0, mapping.xAt(Math.floor(wall.firstSeenAt / 1000))), profileLeft - 12) : 0) * hpr;
      const yy = Math.round(y * vpr);
      const thickness = (3 + 9 * Math.sqrt(wall.size / maxWall)) * vpr;
      const length = width - startX;
      const body = context.createLinearGradient(startX, 0, width, 0);
      body.addColorStop(0, `rgba(${rgb}, 0.04)`);
      body.addColorStop(0.7, `rgba(${rgb}, 0.28)`);
      body.addColorStop(1, `rgba(${rgb}, 0.6)`);
      context.fillStyle = body;
      context.fillRect(startX, yy - thickness / 2, length, thickness);
      // 发光核心线。
      context.save();
      context.shadowColor = `rgba(${rgb}, 0.95)`;
      context.shadowBlur = 12 * hpr;
      context.fillStyle = `rgba(${rgb}, 0.95)`;
      context.fillRect(startX, yy - Math.max(1, 0.75 * vpr), length, Math.max(1.5, 1.5 * vpr));
      context.restore();
      // 流动高光：自右向左掠过墙体，周期约 2.4 秒。
      if (length > 40 * hpr) {
        const sweep = (phase / 2.4 + (wall.price % 7) / 7) % 1;
        const center = width - sweep * length;
        const halo = 60 * hpr;
        const from = Math.max(startX, center - halo);
        const shine = context.createLinearGradient(center - halo, 0, center + halo, 0);
        shine.addColorStop(0, "rgba(255, 255, 255, 0)");
        shine.addColorStop(0.5, "rgba(255, 255, 255, 0.55)");
        shine.addColorStop(1, "rgba(255, 255, 255, 0)");
        context.fillStyle = shine;
        context.fillRect(from, yy - thickness / 2, Math.min(center + halo, width) - from, thickness);
      }
      // 标签胶囊：左侧呼吸点表示“实时”，墙量较峰值明显减少时追加“↓N%”。
      const peak = this.wallPeaks.get(`${wall.side}:${wall.price}`) ?? wall.size;
      const drained = peak > 0 ? 1 - wall.size / peak : 0;
      const label = `${wall.side === "bid" ? this.labels.bidWall : this.labels.askWall} ${compact(wall.size)}${this.labels.contracts}${drained >= WALL_DRAIN_NOTICE ? ` ↓${Math.round(drained * 100)}%` : ""} · ${this.labels.wallAge}${this.formatAge(now - wall.firstSeenAt)}`;
      const textWidth = context.measureText(label).width;
      const pillHeight = 17 * vpr;
      const pillWidth = textWidth + 24 * hpr;
      const pillX = profileLeft * hpr - pillWidth - 10 * hpr;
      const labelY = Math.max(yy, lastLabelY + pillHeight + 3 * vpr);
      lastLabelY = labelY;
      roundedRect(context, pillX, labelY - pillHeight / 2, pillWidth, pillHeight, pillHeight / 2);
      context.fillStyle = "rgba(4, 6, 12, 0.88)";
      context.fill();
      context.lineWidth = Math.max(1, hpr);
      context.strokeStyle = `rgba(${rgb}, 0.7)`;
      context.stroke();
      const pulse = 0.55 + 0.45 * Math.sin(phase * 4);
      context.beginPath();
      context.arc(pillX + 9 * hpr, labelY, 2.6 * hpr, 0, Math.PI * 2);
      context.fillStyle = `rgba(${rgb}, ${pulse})`;
      context.fill();
      context.fillStyle = `rgba(${rgb}, 1)`;
      context.textAlign = "left";
      context.fillText(label, pillX + 16 * hpr, labelY + 0.5 * vpr);
    }
  }

  /** 墙已存在时长：从本次运行首次在盘口看到它开始计；不足 1 分钟显示秒。 */
  private formatAge(ms: number) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}${this.labels.seconds}`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}${this.labels.minutes}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${hours}${this.labels.hours}${rest}${this.labels.minutes}` : `${hours}${this.labels.hours}`;
  }

  /** 清算：径向光斑 + 光环，面积 ∝ 数量；较大的清算加一道纵向光柱与数量标注，最近几根 K 线内的清算持续扩散冲击波。 */
  private drawLiquidations({ context, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }: BitmapScope, mapping: TimeMapping, phase: number) {
    if (this.liquidations.length === 0) return;
    const sizes = this.liquidations.map((mark) => mark.size).sort((left, right) => left - right);
    const maxSize = sizes.at(-1) || 1;
    const bigCut = sizes[Math.floor(sizes.length * 0.8)] ?? maxSize;
    const liveSince = mapping.lastTime - mapping.interval * LIVE_LIQUIDATION_BARS;
    for (const mark of this.liquidations) {
      const x = mapping.xAt(mark.time);
      const y = this.y(mark.price);
      if (y === null || x < -20 || x > mediaSize.width + 20) continue;
      const cx = x * hpr;
      const cy = y * vpr;
      const radius = (4 + 10 * Math.sqrt(mark.size / maxSize)) * hpr;
      const rgb = mark.side === "long" ? ASK_RGB : BID_RGB;
      const big = mark.size >= bigCut;
      if (big) {
        const beam = context.createLinearGradient(0, 0, 0, mediaSize.height * vpr);
        const at = Math.max(0, Math.min(1, y / mediaSize.height));
        beam.addColorStop(0, `rgba(${rgb}, 0)`);
        beam.addColorStop(at, `rgba(${rgb}, 0.32)`);
        beam.addColorStop(1, `rgba(${rgb}, 0)`);
        context.fillStyle = beam;
        context.fillRect(cx - 1.5 * hpr, 0, 3 * hpr, mediaSize.height * vpr);
      }
      const glow = context.createRadialGradient(cx, cy, 0, cx, cy, radius * 2.4);
      glow.addColorStop(0, `rgba(${rgb}, 0.6)`);
      glow.addColorStop(0.4, `rgba(${rgb}, 0.22)`);
      glow.addColorStop(1, `rgba(${rgb}, 0)`);
      context.fillStyle = glow;
      context.beginPath();
      context.arc(cx, cy, radius * 2.4, 0, Math.PI * 2);
      context.fill();
      context.lineWidth = 1.5 * hpr;
      context.strokeStyle = `rgba(${rgb}, 0.95)`;
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = "rgba(255, 255, 255, 0.9)";
      context.beginPath();
      context.arc(cx, cy, Math.max(1.2 * hpr, radius * 0.18), 0, Math.PI * 2);
      context.fill();
      if (mark.time >= liveSince) {
        for (const offset of [0, 0.5]) {
          const progress = (phase / 1.6 + offset) % 1;
          context.lineWidth = (2 - 1.5 * progress) * hpr;
          context.strokeStyle = `rgba(${rgb}, ${0.8 * (1 - progress)})`;
          context.beginPath();
          context.arc(cx, cy, radius * (1 + 2.6 * progress), 0, Math.PI * 2);
          context.stroke();
        }
      }
      if (big) {
        const label = `${mark.side === "long" ? this.labels.longLiquidated : this.labels.shortLiquidated} ${compact(mark.size)}`;
        const above = mark.side === "short";
        context.fillStyle = `rgba(${rgb}, 1)`;
        context.textAlign = "center";
        context.fillText(label, cx, cy + (above ? -1 : 1) * (radius + 11 * vpr));
      }
    }
  }

  /** 背离：两个价格摆点之间的发光连线，端点实心，终点处一枚标签胶囊。 */
  private drawDivergences({ context, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }: BitmapScope, mapping: TimeMapping) {
    const placed: Array<[number, number, number, number]> = [];
    for (const divergence of this.divergences) {
      const x0 = mapping.xAt(divergence.fromTime) * hpr;
      const x1 = mapping.xAt(divergence.toTime) * hpr;
      const y0 = this.y(divergence.fromPrice);
      const y1 = this.y(divergence.toPrice);
      if (y0 === null || y1 === null || x1 < 0 || x0 > mediaSize.width * hpr) continue;
      const rgb = divergence.kind === "bearish" ? ASK_RGB : BID_RGB;
      const offset = (divergence.kind === "bearish" ? -10 : 10) * vpr;
      const a = { x: x0, y: y0 * vpr + offset };
      const b = { x: x1, y: y1 * vpr + offset };
      const line = context.createLinearGradient(a.x, a.y, b.x, b.y);
      line.addColorStop(0, `rgba(${rgb}, 0.35)`);
      line.addColorStop(1, `rgba(${rgb}, 1)`);
      context.save();
      context.shadowColor = `rgba(${rgb}, 0.9)`;
      context.shadowBlur = 10 * hpr;
      context.strokeStyle = line;
      context.lineWidth = 2 * vpr;
      context.setLineDash([7 * hpr, 4 * hpr]);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      context.setLineDash([]);
      for (const point of [a, b]) {
        context.beginPath();
        context.arc(point.x, point.y, 3 * hpr, 0, Math.PI * 2);
        context.fillStyle = `rgba(${rgb}, 1)`;
        context.fill();
      }
      context.restore();
      const label = divergence.kind === "bearish" ? this.labels.bearishDivergence : this.labels.bullishDivergence;
      const textWidth = context.measureText(label).width;
      const pillHeight = 17 * vpr;
      const pillX = Math.min(mediaSize.width * hpr - textWidth - 20 * hpr, b.x - textWidth / 2 - 8 * hpr);
      const pillY = b.y + offset * 1.9 - pillHeight / 2;
      const pillWidth = textWidth + 16 * hpr;
      // 标签与已画的标签重叠时只保留连线。
      if (placed.some(([x, y, w, h]) => pillX < x + w && pillX + pillWidth > x && pillY < y + h && pillY + pillHeight > y)) continue;
      placed.push([pillX, pillY, pillWidth, pillHeight]);
      roundedRect(context, pillX, pillY, pillWidth, pillHeight, 4 * hpr);
      context.fillStyle = `rgba(${rgb}, 0.18)`;
      context.fill();
      context.strokeStyle = `rgba(${rgb}, 0.8)`;
      context.lineWidth = Math.max(1, hpr);
      context.stroke();
      context.fillStyle = `rgba(${rgb}, 1)`;
      context.textAlign = "left";
      context.fillText(label, pillX + 8 * hpr, pillY + pillHeight / 2 + 0.5 * vpr);
    }
  }

  private drawProfileLabels({ context, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }: BitmapScope) {
    const profile = this.profile;
    if (!profile) return;
    const entries: Array<[number | null, string, boolean]> = [
      [profile.poc, this.labels.poc, true],
      [profile.valueAreaHigh, `${this.labels.valueArea}↑`, false],
      [profile.valueAreaLow, `${this.labels.valueArea}↓`, false]
    ];
    for (const [price, label, strong] of entries) {
      if (price === null) continue;
      const y = this.y(price);
      if (y === null || y < 10 || y > mediaSize.height - 10) continue;
      const textWidth = context.measureText(label).width;
      const pillHeight = 15 * vpr;
      const pillX = (mediaSize.width - 6) * hpr - textWidth - 12 * hpr;
      const pillY = y * vpr - pillHeight - 3 * vpr;
      roundedRect(context, pillX, pillY, textWidth + 12 * hpr, pillHeight, 3 * hpr);
      context.fillStyle = strong ? `rgba(${SIGNAL_RGB}, 0.9)` : "rgba(4, 6, 12, 0.82)";
      context.fill();
      if (!strong) {
        context.strokeStyle = `rgba(${SIGNAL_RGB}, 0.55)`;
        context.lineWidth = Math.max(1, hpr);
        context.stroke();
      }
      context.fillStyle = strong ? "rgba(4, 8, 16, 1)" : `rgba(${SIGNAL_RGB}, 1)`;
      context.textAlign = "left";
      context.fillText(label, pillX + 6 * hpr, pillY + pillHeight / 2 + 0.5 * vpr);
    }
  }
}
