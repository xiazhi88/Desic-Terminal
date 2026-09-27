import type {
  IChartApi,
  Logical,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  MouseEventParams,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time
} from "lightweight-charts";
import { liquidityHistory, type LiquidityEvent, type LiquiditySnapshot } from "../../lib/liquidityHistory";

// 流动性热力图图元：挂在 K 线序列上，zOrder=bottom（热力图 → 成交气泡 → K 线）。
// 热力图用 WebGL2 在离屏画布上逐像素查表后 drawImage 到图表画布，
// 与价格轴拖动、缩放天然同步；没有 WebGL2 时只画成交气泡与事件，热力层如实缺席。

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type BitmapScope = Parameters<Parameters<DrawTarget["useBitmapCoordinateSpace"]>[0]>[0];

export type LiquidityLabels = {
  resting: string;
  traded: string;
  pulled: string;
  eaten: string;
  contracts: string;
};

type TimeMapping = { secAt: (x: number) => number; xAt: (sec: number) => number; secondsPerPixel: number };

const EFFECT_MS = 1200;
const BID_RGB = "14, 203, 129";
const ASK_RGB = "246, 70, 93";

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = vec2((aPosition.x + 1.0) * 0.5, (1.0 - aPosition.y) * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

// 年龄与价格都用相对量传入：秒级 Unix 时间超出 float32 精度。
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uValues;
uniform sampler2D uOrigins;
uniform float uAgeLeft;
uniform float uAgeRight;
uniform float uBucketTop;
uniform float uBucketBottom;
uniform int uHeadIndex;
uniform int uFilled;
uniform int uColumns;
uniform int uRows;
uniform float uFloor;
uniform float uCeil;

vec3 ramp(float t) {
  vec3 c0 = vec3(0.06, 0.03, 0.12);
  vec3 c1 = vec3(0.26, 0.10, 0.48);
  vec3 c2 = vec3(0.70, 0.19, 0.55);
  vec3 c3 = vec3(0.95, 0.60, 0.24);
  vec3 c4 = vec3(1.00, 0.96, 0.86);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.78) return mix(c2, c3, (t - 0.5) / 0.28);
  return mix(c3, c4, (t - 0.78) / 0.22);
}

void main() {
  float ageExact = mix(uAgeLeft, uAgeRight, vUv.x);
  int age = int(ceil(ageExact - 0.0001));
  if (age < 0 || age >= uFilled) { outColor = vec4(0.0); return; }
  int column = (uHeadIndex - age + uColumns) % uColumns;
  float origin = texelFetch(uOrigins, ivec2(column, 0), 0).r;
  float bucket = floor(mix(uBucketTop, uBucketBottom, vUv.y));
  int row = int(bucket - origin);
  if (row < 0 || row >= uRows) { outColor = vec4(0.0); return; }
  float value = texelFetch(uValues, ivec2(row, column), 0).r;
  float t = pow(clamp((value - uFloor) / max(uCeil - uFloor, 0.01), 0.0, 1.0), 0.72);
  float alpha = (0.18 + 0.74 * smoothstep(0.0, 0.35, t)) * step(0.0001, value);
  outColor = vec4(ramp(t) * alpha, alpha);
}`;

class HeatmapRenderer {
  readonly canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null = null;
  private valuesTexture: WebGLTexture | null = null;
  private originsTexture: WebGLTexture | null = null;
  private uploadedInstId = "";
  private uploadedHeadSec = 0;
  private uploadedHeadIndex = -1;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  readonly supported: boolean;

  constructor() {
    this.gl = this.canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    this.supported = Boolean(this.gl && this.init());
  }

  private init() {
    const gl = this.gl!;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (maxSize < liquidityHistory.columns) return false;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) return false;
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    this.program = program;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    for (const name of ["uValues", "uOrigins", "uAgeLeft", "uAgeRight", "uBucketTop", "uBucketBottom", "uHeadIndex", "uFilled", "uColumns", "uRows", "uFloor", "uCeil"]) {
      this.uniforms.set(name, gl.getUniformLocation(program, name));
    }
    this.valuesTexture = createTexture(gl);
    this.originsTexture = createTexture(gl);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    return true;
  }

  // 每秒只新增列：按上次上传后的秒数差补传新列；换交易对或落后超过一整窗时整张重传。
  private upload(snapshot: LiquiditySnapshot) {
    const gl = this.gl!;
    const behind = snapshot.headSec - this.uploadedHeadSec;
    const full = snapshot.instId !== this.uploadedInstId || this.uploadedHeadIndex < 0 || behind < 0 || behind >= snapshot.columns;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.valuesTexture);
    if (full) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, snapshot.rows, snapshot.columns, 0, gl.RED, gl.UNSIGNED_BYTE, snapshot.values);
    } else {
      for (let step = 1; step <= behind; step += 1) {
        const column = (this.uploadedHeadIndex + step) % snapshot.columns;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, column, snapshot.rows, 1, gl.RED, gl.UNSIGNED_BYTE, snapshot.values.subarray(column * snapshot.rows, (column + 1) * snapshot.rows));
      }
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.originsTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, snapshot.columns, 1, 0, gl.RED, gl.FLOAT, snapshot.origins);
    this.uploadedInstId = snapshot.instId;
    this.uploadedHeadSec = snapshot.headSec;
    this.uploadedHeadIndex = snapshot.headIndex;
  }

  render(snapshot: LiquiditySnapshot, width: number, height: number, ageLeft: number, ageRight: number, bucketTop: number, bucketBottom: number, floor: number, ceil: number) {
    const gl = this.gl;
    if (!gl || !this.program) return false;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (snapshot.headSec !== this.uploadedHeadSec || snapshot.instId !== this.uploadedInstId || this.uploadedHeadIndex < 0) this.upload(snapshot);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.valuesTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.originsTexture);
    const set = (name: string) => this.uniforms.get(name) ?? null;
    gl.uniform1i(set("uValues"), 0);
    gl.uniform1i(set("uOrigins"), 1);
    gl.uniform1f(set("uAgeLeft"), ageLeft);
    gl.uniform1f(set("uAgeRight"), ageRight);
    gl.uniform1f(set("uBucketTop"), bucketTop);
    gl.uniform1f(set("uBucketBottom"), bucketBottom);
    gl.uniform1i(set("uHeadIndex"), snapshot.headIndex);
    gl.uniform1i(set("uFilled"), snapshot.filled);
    gl.uniform1i(set("uColumns"), snapshot.columns);
    gl.uniform1i(set("uRows"), snapshot.rows);
    gl.uniform1f(set("uFloor"), floor);
    gl.uniform1f(set("uCeil"), ceil);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteTexture(this.valuesTexture);
    gl.deleteTexture(this.originsTexture);
    gl.deleteProgram(this.program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function createTexture(gl: WebGL2RenderingContext) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

export class LiquidityHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private frame: number | null = null;
  private renderer: HeatmapRenderer | null = null;
  private crosshair: { x: number; y: number } | null = null;
  private gain = 1.25;
  private levels: { floor: number; ceil: number } | null = null;
  private levelsAt = 0;
  private readonly bottomView: IPrimitivePaneView;
  private readonly topView: IPrimitivePaneView;
  private readonly reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  constructor(private readonly instId: string, private readonly labels: LiquidityLabels) {
    const bottom: IPrimitivePaneRenderer = { draw: (target) => this.drawBottom(target) };
    const top: IPrimitivePaneRenderer = { draw: (target) => this.drawTop(target) };
    this.bottomView = { zOrder: (): PrimitivePaneViewZOrder => "bottom", renderer: () => bottom };
    this.topView = { zOrder: (): PrimitivePaneViewZOrder => "top", renderer: () => top };
  }

  get heatmapSupported() {
    return this.renderer?.supported ?? false;
  }

  setGain(gain: number) {
    this.gain = gain;
    this.schedule();
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
    this.renderer = new HeatmapRenderer();
    this.unsubscribe = liquidityHistory.subscribe(() => this.schedule());
    chart.subscribeCrosshairMove(this.handleCrosshair);
    this.schedule();
  }

  detached() {
    this.unsubscribe?.();
    this.chart?.unsubscribeCrosshairMove(this.handleCrosshair);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return [this.bottomView, this.topView];
  }

  private handleCrosshair = (params: MouseEventParams<Time>) => {
    this.crosshair = params.point ? { x: params.point.x, y: params.point.y } : null;
  };

  private schedule() {
    if (this.frame !== null || !this.requestUpdate) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.requestUpdate?.();
    });
  }

  // 用 K 线序列真实时间做线性映射：蜡烛中心 = 开盘时间，蜡烛覆盖 [开盘, 开盘 + 周期)。
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
    const secondsPerPixel = interval / spacing;
    const xAt = (sec: number) => x0 + ((sec - t0) / interval - 0.5) * spacing;
    const secAt = (x: number) => t0 + ((x - x0) / spacing + 0.5) * interval;
    return { xAt, secAt, secondsPerPixel };
  }

  private drawBottom(target: DrawTarget) {
    target.useBitmapCoordinateSpace((scope) => {
      const snapshot = liquidityHistory.instId === this.instId ? liquidityHistory.snapshot() : null;
      const mapping = this.timeMapping();
      if (!mapping || !this.series || !snapshot) return;
      this.drawHeatmap(scope, snapshot, mapping);
      this.drawBubbles(scope, mapping);
      this.drawEvents(scope, mapping);
    });
  }

  private drawHeatmap(scope: BitmapScope, snapshot: LiquiditySnapshot, mapping: TimeMapping) {
    const renderer = this.renderer;
    const series = this.series!;
    if (!renderer?.supported) return;
    const { context, bitmapSize, mediaSize } = scope;
    const priceTop = series.coordinateToPrice(0);
    const priceBottom = series.coordinateToPrice(mediaSize.height);
    if (priceTop === null || priceBottom === null) return;
    const secLeft = mapping.secAt(0);
    const secRight = mapping.secAt(mediaSize.width);
    // 自动色阶：常规挂单落在暗部，只有分布尾部的大额挂单发亮；对比度滑块只压缩亮部上限。
    const nowMs = performance.now();
    if (!this.levels || nowMs - this.levelsAt > 1500) {
      this.levels = liquidityHistory.levels() ?? this.levels;
      this.levelsAt = nowMs;
    }
    const levels = this.levels ?? { floor: 0.2, ceil: 0.9 };
    const ceil = levels.floor + (levels.ceil - levels.floor) / Math.max(this.gain, 0.1);
    const rendered = renderer.render(
      snapshot,
      bitmapSize.width,
      bitmapSize.height,
      snapshot.headSec - secLeft,
      snapshot.headSec - secRight,
      Number(priceTop) / snapshot.bucket,
      Number(priceBottom) / snapshot.bucket,
      levels.floor,
      ceil
    );
    if (rendered) context.drawImage(renderer.canvas, 0, 0);
  }

  // 成交气泡：按屏幕宽度自适应的时间桶按买卖方向聚合，只画成交量高于视野内 88 分位的桶。
  private drawBubbles(scope: BitmapScope, mapping: TimeMapping) {
    const series = this.series!;
    const { context, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
    const secLeft = mapping.secAt(0);
    const secRight = mapping.secAt(mediaSize.width);
    const bucketSec = Math.max(3, Math.min(60, Math.round((secRight - secLeft) / 180)));
    const buckets = new Map<string, { sec: number; volume: number; notional: number; buy: boolean }>();
    liquidityHistory.forEachTrade(secLeft, secRight, (time, price, size, buy) => {
      const slot = Math.floor(time / bucketSec) * bucketSec;
      const key = `${slot}:${buy ? 1 : 0}`;
      const bucket = buckets.get(key) ?? { sec: slot + bucketSec / 2, volume: 0, notional: 0, buy };
      bucket.volume += size;
      bucket.notional += size * price;
      buckets.set(key, bucket);
    });
    if (buckets.size === 0) return;
    const volumes = [...buckets.values()].map((bucket) => bucket.volume).sort((a, b) => a - b);
    const threshold = volumes[Math.floor(volumes.length * 0.88)] ?? volumes.at(-1)!;
    const max = volumes.at(-1)!;
    context.save();
    for (const bucket of buckets.values()) {
      if (bucket.volume < threshold) continue;
      const y = series.priceToCoordinate(bucket.notional / bucket.volume);
      if (y === null) continue;
      const x = mapping.xAt(bucket.sec);
      const scale = max > threshold ? Math.sqrt((bucket.volume - threshold) / (max - threshold)) : 1;
      const radius = (4 + scale * 13) * hpr;
      const rgb = bucket.buy ? BID_RGB : ASK_RGB;
      context.beginPath();
      context.arc(x * hpr, Number(y) * vpr, radius, 0, Math.PI * 2);
      context.fillStyle = `rgba(${rgb}, 0.12)`;
      context.fill();
      context.lineWidth = Math.max(1, hpr);
      context.strokeStyle = `rgba(${rgb}, 0.6)`;
      context.stroke();
    }
    context.restore();
  }

  // 大单墙事件：成交消耗 = 实心 × + 刚发生时沿墙体的熄灭与粒子；撤出 = 虚线幽灵 + “撤单”标签。
  private drawEvents(scope: BitmapScope, mapping: TimeMapping) {
    const series = this.series!;
    const { context, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
    const secLeft = mapping.secAt(0);
    const secRight = mapping.secAt(mediaSize.width);
    const now = performance.now();
    let animating = false;
    const placedLabels: Array<{ x: number; y: number }> = [];
    context.save();
    context.font = `${10 * vpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    for (const event of liquidityHistory.events) {
      if (event.timeSec < secLeft || event.firstSeenSec > secRight) continue;
      const y = series.priceToCoordinate(event.price);
      if (y === null) continue;
      const yy = Number(y) * vpr;
      const x0 = mapping.xAt(event.firstSeenSec) * hpr;
      const x1 = mapping.xAt(event.timeSec) * hpr;
      const rgb = event.side === "bid" ? BID_RGB : ASK_RGB;
      if (event.kind === "pulled") {
        context.setLineDash([4 * hpr, 3 * hpr]);
        context.strokeStyle = "rgba(200, 200, 215, 0.55)";
        context.lineWidth = Math.max(1, hpr);
        context.beginPath();
        context.moveTo(x0, yy);
        context.lineTo(x1, yy);
        context.stroke();
        context.setLineDash([]);
        const labelX = x1 + 4 * hpr;
        const labelY = yy - 3 * vpr;
        const collides = placedLabels.some((label) => Math.abs(label.x - labelX) < 46 * hpr && Math.abs(label.y - labelY) < 12 * vpr);
        if (!collides && x1 - x0 > 24 * hpr) {
          placedLabels.push({ x: labelX, y: labelY });
          context.fillStyle = "rgba(200, 200, 215, 0.7)";
          context.fillText(this.labels.pulled, labelX, labelY);
        }
        continue;
      }
      const size = 3.5 * hpr;
      context.strokeStyle = `rgba(${rgb}, 0.95)`;
      context.lineWidth = Math.max(1.5, 1.5 * hpr);
      context.beginPath();
      context.moveTo(x1 - size, yy - size);
      context.lineTo(x1 + size, yy + size);
      context.moveTo(x1 + size, yy - size);
      context.lineTo(x1 - size, yy + size);
      context.stroke();
      const age = now - event.detectedAt;
      if (this.reducedMotion || age >= EFFECT_MS) continue;
      animating = true;
      const progress = age / EFFECT_MS;
      // 熄灭：沿墙体从起点向成交点收拢的亮线，随时间变暗。
      const collapse = Math.min(1, progress / 0.3);
      const streakStart = x0 + (x1 - x0) * collapse;
      context.strokeStyle = `rgba(255, 244, 220, ${0.9 * (1 - progress)})`;
      context.lineWidth = 2 * vpr;
      context.beginPath();
      context.moveTo(streakStart, yy);
      context.lineTo(x1, yy);
      context.stroke();
      // 粒子：按事件 id 确定性散开，不随机闪烁。
      if (progress > 0.25) {
        const burst = (progress - 0.25) / 0.75;
        context.fillStyle = `rgba(${rgb}, ${0.85 * (1 - burst)})`;
        for (let index = 0; index < 14; index += 1) {
          const angle = ((index * 137.5 + event.id * 29) % 360) * (Math.PI / 180);
          const distance = (8 + (index % 4) * 5) * burst * hpr;
          context.beginPath();
          context.arc(x1 + Math.cos(angle) * distance, yy + Math.sin(angle) * distance, 1.3 * hpr, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
    context.restore();
    if (animating) this.schedule();
  }

  private drawTop(target: DrawTarget) {
    const crosshair = this.crosshair;
    const series = this.series;
    if (!crosshair || !series) return;
    target.useBitmapCoordinateSpace(({ context, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const mapping = this.timeMapping();
      const price = series.coordinateToPrice(crosshair.y);
      if (!mapping || price === null || liquidityHistory.instId !== this.instId) return;
      const sec = mapping.secAt(crosshair.x);
      const resting = liquidityHistory.restingAt(sec, Number(price));
      if (resting === null) return;
      const traded = liquidityHistory.tradedAt(Number(price), mapping.secAt(0), mapping.secAt(mediaSize.width));
      const lines = [
        `${this.labels.resting} ≈ ${formatSize(resting)} ${this.labels.contracts}`,
        `${this.labels.traded} ${formatSize(traded)} ${this.labels.contracts}`
      ];
      context.save();
      context.font = `${10.5 * vpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const width = Math.max(...lines.map((line) => context.measureText(line).width)) + 14 * hpr;
      const height = (lines.length * 14 + 8) * vpr;
      const x = (crosshair.x + 14) * hpr;
      const y = (crosshair.y + 14) * vpr;
      context.fillStyle = "rgba(8, 9, 14, 0.88)";
      context.strokeStyle = "rgba(200, 200, 230, 0.18)";
      context.lineWidth = hpr;
      context.beginPath();
      context.roundRect(x, y, width, height, 4 * hpr);
      context.fill();
      context.stroke();
      context.fillStyle = "rgba(240, 240, 248, 0.92)";
      lines.forEach((line, index) => context.fillText(line, x + 7 * hpr, y + (15 + index * 14) * vpr));
      context.restore();
    });
  }
}

function formatSize(value: number) {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}K`;
  if (value >= 100) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

export type { LiquidityEvent };
