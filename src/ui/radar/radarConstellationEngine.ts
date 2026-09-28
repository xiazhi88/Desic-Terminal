import type { ConstellationFactor, ConstellationModel } from "./constellationModel";

// 市场星图渲染引擎（与 React 解耦）：网格层（2D）+ 星点 / 彗尾层（WebGL2）+ 叠加层（2D：质心、标签、扫描、套索）。
// 颜色只表达 24h 涨跌（红涨绿跌），点大小 = 成交额，光晕只给近 6 小时综合名次显著变化的合约（活数据）。

export type AxisLabels = { x: string; y: string; xLow: string; xHigh: string; yLow: string; yHigh: string };

export type EngineCallbacks = {
  onHover: (index: number | null, clientX: number, clientY: number) => void;
  /** -1 = 点击空白处，清除选中。 */
  onSelect: (index: number) => void;
  /** ⌘ / Ctrl 点击：加入或移出比较。 */
  onToggleCompare: (index: number) => void;
  onLasso: (indices: number[]) => void;
  onTime: (frame: number, playing: boolean) => void;
};

const PAD = { left: 46, right: 18, top: 58, bottom: 36 };
const PT_STRIDE = 8;
const TRAIL_SEG = 16;
/** 比较序列色（与比较面板一致）。 */
export const COMPARE_SERIES = ["#ecebf4", "#5fd4e0", "#f3b23c", "#86a8ff"];
const UI_FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const NUM_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";
const INK = { ink: "#f4f4fa", ink2: "#b9bacb", ink3: "#7e8096", ink4: "#53556a", bg: "#05060b", live: "#5fd4e0" };
const CHANGE_SCALE = 10;

const POINT_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_size;
layout(location=2) in float a_chg;
layout(location=3) in float a_live;
layout(location=4) in float a_flash;
layout(location=5) in float a_alpha;
uniform vec2 u_res; uniform float u_dpr; uniform int u_pass;
out float v_size; out float v_ext; out vec3 v_col; out float v_live; out float v_flash; out float v_alpha;
vec3 chgColor(float c) {
  float t = clamp(c, -1.0, 1.0);
  vec3 n = vec3(0.47, 0.48, 0.56);
  vec3 up = vec3(1.0, 0.30, 0.42);
  vec3 dn = vec3(0.10, 0.85, 0.60);
  return t >= 0.0 ? mix(n, up, pow(t, 0.85)) : mix(n, dn, pow(-t, 0.85));
}
void main() {
  vec2 p = a_pos / u_res * 2.0 - 1.0;
  p.y = -p.y;
  gl_Position = vec4(p, 0.0, 1.0);
  float ext = u_pass == 0 ? a_size + 6.0 + 12.0 * a_live + 20.0 * a_flash : a_size + 1.5;
  gl_PointSize = ext * 2.0 * u_dpr;
  v_size = a_size; v_ext = ext; v_col = chgColor(a_chg);
  v_live = a_live; v_flash = a_flash; v_alpha = a_alpha;
}`;

const POINT_FS = `#version 300 es
precision highp float;
precision highp int;
in float v_size; in float v_ext; in vec3 v_col; in float v_live; in float v_flash; in float v_alpha;
uniform int u_pass;
out vec4 o;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0) * v_ext;
  if (u_pass == 0) {
    float k = d / (v_size + 2.5 + 7.0 * v_live + 12.0 * v_flash);
    float glow = exp(-k * k * 2.6) * (0.42 * v_live + 0.95 * v_flash) * v_alpha;
    vec3 c = mix(v_col, vec3(1.0), 0.3 * v_flash);
    o = vec4(c * glow, glow * 0.6);
  } else {
    float a = smoothstep(v_size + 0.75, v_size - 0.45, d) * v_alpha;
    float rim = smoothstep(v_size - 1.5, v_size - 0.2, d);
    vec3 c = mix(v_col, v_col * 0.5, rim * 0.55 * step(2.6, v_size));
    c = mix(c, vec3(1.0), 0.6 * v_flash);
    o = vec4(c * a, a);
  }
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_col;
uniform vec2 u_res;
out vec4 v_col;
void main() {
  vec2 p = a_pos / u_res * 2.0 - 1.0;
  p.y = -p.y;
  gl_Position = vec4(p, 0.0, 1.0);
  v_col = a_col;
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_col; out vec4 o;
void main() { o = v_col; }`;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function changeRgb(change: number): [number, number, number] {
  const t = clamp(change / CHANGE_SCALE, -1, 1);
  const neutral = [0.47, 0.48, 0.56];
  const target = t >= 0 ? [1.0, 0.3, 0.42] : [0.1, 0.85, 0.6];
  const f = Math.pow(Math.abs(t), 0.85);
  return [neutral[0]! + (target[0]! - neutral[0]!) * f, neutral[1]! + (target[1]! - neutral[1]!) * f, neutral[2]! + (target[2]! - neutral[2]!) * f];
}

export class RadarConstellationEngine {
  private readonly grid = document.createElement("canvas");
  private readonly glCanvas = document.createElement("canvas");
  private readonly overlay = document.createElement("canvas");
  private readonly gl: WebGL2RenderingContext | null;
  private pointProgram: WebGLProgram | null = null;
  private lineProgram: WebGLProgram | null = null;
  private pointVao: WebGLVertexArrayObject | null = null;
  private lineVao: WebGLVertexArrayObject | null = null;
  private pointBuffer: WebGLBuffer | null = null;
  private lineBuffer: WebGLBuffer | null = null;
  private pointData = new Float32Array(0);
  private lineData = new Float32Array(0);
  private model: ConstellationModel | null = null;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private region = { x0: 0, y0: 0, x1: 1, y1: 1 };
  /** 坐标轴可见范围（0–100 尺度内）：按回放区间的数据分布收紧，避免星点挤在中间、四周大片留白。 */
  private domainX: [number, number] = [0, 100];
  private domainY: [number, number] = [0, 100];
  private xFactor: ConstellationFactor = "strength";
  private yFactor: ConstellationFactor = "activity";
  private labels: AxisLabels = { x: "", y: "", xLow: "", xHigh: "", yLow: "", yHigh: "" };
  private frame = 0;
  private playing = false;
  private framesPerSecond = 1;
  private scrubbing = false;
  // 每个点：目标值 t*、显示值 d*（逐帧指数逼近）
  private tx = new Float32Array(0);
  private ty = new Float32Array(0);
  private tsz = new Float32Array(0);
  private tchg = new Float32Array(0);
  private tlive = new Float32Array(0);
  private talpha = new Float32Array(0);
  private dx = new Float32Array(0);
  private dy = new Float32Array(0);
  private ds = new Float32Array(0);
  private flash = new Float32Array(0);
  private drawOrder: number[] = [];
  private orderFrame = -1;
  private axisAnimation: { start: number; fromX: Float32Array; fromY: Float32Array } | null = null;
  private focusMask: Uint8Array | null = null;
  private hiddenCategories = new Set<string>();
  private categoryNames: Record<string, string> = {};
  private categoryFocus: string | null = null;
  private showTrails = true;
  private showCentroids = true;
  private badges = new Map<number, { delta: number; at: number }>();
  private birthDelay = new Float32Array(0);
  private readonly bootAt = performance.now();
  private selected = -1;
  private compare: number[] = [];
  private hover = -1;
  private sweepState: { start: number; changed: Map<number, number>; fired: Set<number>; phi: number; fade: number } | null = null;
  private lasso: Array<[number, number]> | null = null;
  private raf: number | null = null;
  private lastTick = performance.now();
  private lastTimeEmit = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private disposed = false;

  constructor(private readonly host: HTMLElement, private readonly callbacks: EngineCallbacks) {
    for (const canvas of [this.grid, this.glCanvas, this.overlay]) {
      canvas.className = "radar-constellation__layer";
      host.appendChild(canvas);
    }
    this.overlay.classList.add("is-interactive");
    this.gl = this.glCanvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true });
    if (this.gl) this.initGl(this.gl);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.bindPointer();
    this.resize();
    document.addEventListener("visibilitychange", this.handleVisibility);
    this.start();
  }

  get webglAvailable() {
    return Boolean(this.gl && this.pointProgram);
  }

  destroy() {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.host.replaceChildren();
  }

  setModel(model: ConstellationModel) {
    const previous = this.model;
    const keepPositions = previous && previous.count === model.count && previous.instIds.every((id, index) => id === model.instIds[index]);
    this.model = model;
    const n = model.count;
    if (!keepPositions) {
      this.tx = new Float32Array(n);
      this.ty = new Float32Array(n);
      this.tsz = new Float32Array(n);
      this.tchg = new Float32Array(n);
      this.tlive = new Float32Array(n);
      this.talpha = new Float32Array(n);
      this.dx = new Float32Array(n);
      this.dy = new Float32Array(n);
      this.ds = new Float32Array(n);
      this.flash = new Float32Array(n);
      this.birthDelay = Float32Array.from({ length: n }, () => (this.reducedMotion ? 0 : 0.05 + Math.random() * 0.55));
      this.drawOrder = Array.from({ length: n }, (_, index) => index);
      this.pointData = new Float32Array(n * PT_STRIDE);
      this.lineData = new Float32Array(n * TRAIL_SEG * 2 * 6 + 64);
      if (this.gl && this.pointBuffer && this.lineBuffer) {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.pointBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.pointData.byteLength, this.gl.DYNAMIC_DRAW);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.lineBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.lineData.byteLength, this.gl.DYNAMIC_DRAW);
      }
      this.frame = Math.max(0, model.frames - 1);
    } else {
      // 新数据到达时停在实时端（若原本就在实时端），否则保持回放位置。
      const wasAtEnd = previous && this.frame >= previous.frames - 1 - 1e-6;
      this.frame = wasAtEnd ? Math.max(0, model.frames - 1) : clamp(this.frame, 0, Math.max(0, model.frames - 1));
    }
    this.orderFrame = -1;
    this.drawGrid();
    this.emitTime(true);
  }

  setAxes(x: ConstellationFactor, y: ConstellationFactor, labels: AxisLabels) {
    const changed = x !== this.xFactor || y !== this.yFactor;
    this.xFactor = x;
    this.yFactor = y;
    this.labels = labels;
    if (changed && !this.reducedMotion && this.model) {
      this.axisAnimation = { start: performance.now(), fromX: this.dx.slice(), fromY: this.dy.slice() };
    }
    this.drawGrid();
  }

  setDomain(x: [number, number], y: [number, number]) {
    if (x[0] === this.domainX[0] && x[1] === this.domainX[1] && y[0] === this.domainY[0] && y[1] === this.domainY[1]) return;
    const shift = Math.max(Math.abs(x[0] - this.domainX[0]), Math.abs(x[1] - this.domainX[1]), Math.abs(y[0] - this.domainY[0]), Math.abs(y[1] - this.domainY[1]));
    // 实时刷新带来的细微变化直接生效（星点本身有平滑逼近）；明显的视野变化才播放过渡。
    if (shift > 2 && !this.reducedMotion && this.model && !this.axisAnimation) {
      this.axisAnimation = { start: performance.now(), fromX: this.dx.slice(), fromY: this.dy.slice() };
    }
    this.domainX = x;
    this.domainY = y;
    this.drawGrid();
  }

  setFrame(frame: number, scrubbing = false) {
    if (!this.model) return;
    this.frame = clamp(frame, 0, Math.max(0, this.model.frames - 1));
    this.scrubbing = scrubbing;
    this.emitTime(true);
  }

  play(framesPerSecond: number) {
    if (!this.model || this.model.frames < 2) return;
    if (this.frame >= this.model.frames - 1) this.frame = 0;
    this.framesPerSecond = framesPerSecond;
    this.playing = true;
    this.emitTime(true);
  }

  setSpeed(framesPerSecond: number) {
    this.framesPerSecond = framesPerSecond;
  }

  pause() {
    this.playing = false;
    this.emitTime(true);
  }

  setFocus(mask: Uint8Array | null) {
    this.focusMask = mask;
  }

  setHiddenCategories(categories: Set<string>) {
    this.hiddenCategories = categories;
  }

  setCategoryNames(names: Record<string, string>) {
    this.categoryNames = names;
  }

  setCategoryFocus(category: string | null) {
    this.categoryFocus = category;
  }

  setLayers(trails: boolean, centroids: boolean) {
    this.showTrails = trails;
    this.showCentroids = centroids;
  }

  setSelection(selected: number, compare: number[]) {
    this.selected = selected;
    this.compare = compare;
  }

  /** 一次性雷达扫描：扫过时点亮名次发生变化的点（delta > 0 = 上升）。 */
  sweep(changed: Map<number, number>) {
    if (this.reducedMotion || changed.size === 0) return;
    this.sweepState = { start: performance.now(), changed, fired: new Set(), phi: 0, fade: 1 };
  }

  private handleVisibility = () => {
    if (document.hidden) {
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      this.raf = null;
    } else {
      this.start();
    }
  };

  private start() {
    if (this.raf !== null || this.disposed) return;
    this.lastTick = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this.lastTick) / 1000);
      this.lastTick = now;
      this.advance(dt, now);
      this.computeTargets();
      this.integrate(dt, now);
      this.sweepStep(now);
      this.drawGl();
      this.drawOverlay(now);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private advance(dt: number, now: number) {
    if (!this.playing || !this.model) return;
    this.frame += dt * this.framesPerSecond;
    if (this.frame >= this.model.frames - 1) {
      this.frame = this.model.frames - 1;
      this.playing = false;
      this.emitTime(true);
      return;
    }
    if (now - this.lastTimeEmit > 120) this.emitTime(false);
  }

  private emitTime(force: boolean) {
    this.lastTimeEmit = performance.now();
    if (force || this.playing) this.callbacks.onTime(this.frame, this.playing);
  }

  private initGl(gl: WebGL2RenderingContext) {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const link = (vs: string, fs: string) => {
      const vertex = compile(gl.VERTEX_SHADER, vs);
      const fragment = compile(gl.FRAGMENT_SHADER, fs);
      if (!vertex || !fragment) return null;
      const program = gl.createProgram()!;
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
    };
    this.pointProgram = link(POINT_VS, POINT_FS);
    this.lineProgram = link(LINE_VS, LINE_FS);
    if (!this.pointProgram || !this.lineProgram) {
      this.pointProgram = null;
      return;
    }
    this.pointVao = gl.createVertexArray();
    gl.bindVertexArray(this.pointVao);
    this.pointBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    const stride = PT_STRIDE * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    [1, 2, 3, 4, 5].forEach((location, offset) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 1, gl.FLOAT, false, stride, (2 + offset) * 4);
    });
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    this.lineBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);
  }

  resize() {
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 尺寸没变就不动画布：重设 canvas 宽高会清空并重新分配（含 WebGL 绘图缓冲），代价很高。
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    for (const canvas of [this.grid, this.glCanvas, this.overlay]) {
      canvas.width = Math.round(this.width * this.dpr);
      canvas.height = Math.round(this.height * this.dpr);
    }
    this.region = { x0: PAD.left, y0: PAD.top, x1: this.width - PAD.right, y1: this.height - PAD.bottom };
    this.drawGrid();
  }

  private sx(value: number) {
    const [low, high] = this.domainX;
    return this.region.x0 + ((value - low) / (high - low)) * (this.region.x1 - this.region.x0);
  }

  private sy(value: number) {
    const [low, high] = this.domainY;
    return this.region.y1 - ((value - low) / (high - low)) * (this.region.y1 - this.region.y0);
  }

  private token(name: string, fallback: string) {
    return getComputedStyle(this.host).getPropertyValue(name).trim() || fallback;
  }

  private drawGrid() {
    const context = this.grid.getContext("2d");
    if (!context) return;
    const { x0, y0, x1, y1 } = this.region;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    const hair = "rgba(200, 200, 230, 0.07)";
    const hairStrong = "rgba(200, 200, 230, 0.14)";
    const weak = this.token("--weak", "#6e7187");
    const muted = this.token("--muted", "#b3b5c6");
    context.lineWidth = 1;
    context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    // 刻度随可见范围取 5 或 10 的倍数；50（全市场均值）画虚线。
    const drawAxis = (axis: "x" | "y") => {
      const [low, high] = axis === "x" ? this.domainX : this.domainY;
      const step = high - low <= 45 ? 5 : 10;
      for (let value = Math.ceil(low / step) * step; value <= high + 1e-6; value += step) {
        const major = value % 10 === 0;
        if (axis === "x") {
          const x = Math.round(this.sx(value)) + 0.5;
          context.strokeStyle = value === 50 ? hairStrong : hair;
          context.globalAlpha = major ? 1 : 0.45;
          context.setLineDash(value === 50 ? [2, 4] : []);
          context.beginPath();
          context.moveTo(x, y0);
          context.lineTo(x, y1);
          context.stroke();
          context.globalAlpha = 1;
          if (major) {
            context.fillStyle = weak;
            context.textAlign = "center";
            context.textBaseline = "top";
            context.fillText(String(value), x, y1 + 7);
          }
        } else {
          const y = Math.round(this.sy(value)) + 0.5;
          context.strokeStyle = value === 50 ? hairStrong : hair;
          context.globalAlpha = major ? 1 : 0.45;
          context.setLineDash(value === 50 ? [2, 4] : []);
          context.beginPath();
          context.moveTo(x0, y);
          context.lineTo(x1, y);
          context.stroke();
          context.globalAlpha = 1;
          if (major) {
            context.fillStyle = weak;
            context.textAlign = "right";
            context.textBaseline = "middle";
            context.fillText(String(value), x0 - 8, y);
          }
        }
      }
    };
    drawAxis("x");
    drawAxis("y");
    context.setLineDash([]);
    context.strokeStyle = hairStrong;
    context.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    context.font = "600 10px ui-sans-serif, system-ui, sans-serif";
    context.fillStyle = muted;
    context.textAlign = "right";
    context.textBaseline = "top";
    context.fillText(`${this.labels.x}  →`, x1, y1 + 22);
    context.save();
    context.translate(x0 - 36, y0);
    context.rotate(-Math.PI / 2);
    context.textAlign = "right";
    context.textBaseline = "top";
    context.fillText(`${this.labels.y}  →`, 0, 0);
    context.restore();
    context.font = "11px ui-sans-serif, system-ui, sans-serif";
    context.fillStyle = weak;
    const inset = 10;
    context.textBaseline = "top";
    context.textAlign = "right";
    context.fillText(`${this.labels.xHigh} · ${this.labels.yHigh}`, x1 - inset, y0 + inset);
    context.textAlign = "left";
    context.fillText(`${this.labels.xLow} · ${this.labels.yHigh}`, x0 + inset, y0 + inset);
    context.textBaseline = "bottom";
    context.fillText(`${this.labels.xLow} · ${this.labels.yLow}`, x0 + inset, y1 - inset);
    context.textAlign = "right";
    context.fillText(`${this.labels.xHigh} · ${this.labels.yLow}`, x1 - inset, y1 - inset);
  }

  // 两帧之间线性插值；中间是快照空洞时不插值，直接取最近帧（如实跳变）。
  private sample(array: Float32Array, index: number, frame: number) {
    const model = this.model!;
    const f0 = Math.floor(frame);
    const f1 = Math.min(model.frames - 1, f0 + 1);
    const t = frame - f0;
    const k0 = f0 * model.count + index;
    const k1 = f1 * model.count + index;
    if (!model.valid[k1] || model.gapAfter[f0]) return array[t > 0.5 && model.valid[k1] ? k1 : k0]!;
    if (!model.valid[k0]) return array[k1]!;
    return array[k0]! + (array[k1]! - array[k0]!) * t;
  }

  private isValid(index: number) {
    const model = this.model!;
    return model.valid[Math.round(this.frame) * model.count + index] === 1;
  }

  private alphaOf(index: number) {
    const model = this.model!;
    if (!this.isValid(index)) return 0;
    if (this.hiddenCategories.has(model.categories[index]!)) return 0;
    let alpha = 1;
    if (this.focusMask && !this.focusMask[index]) alpha = 0.13;
    if (this.categoryFocus && model.categories[index] !== this.categoryFocus) alpha = Math.min(alpha, 0.13);
    if (this.compare.length > 0 && !this.compare.includes(index)) alpha = Math.min(alpha, 0.35);
    return alpha;
  }

  private computeTargets() {
    const model = this.model;
    if (!model || model.frames === 0) return;
    const frame = this.frame;
    const nearest = Math.round(frame);
    const x = model.factors[this.xFactor];
    const y = model.factors[this.yFactor];
    for (let index = 0; index < model.count; index += 1) {
      const alpha = this.alphaOf(index);
      this.talpha[index] = alpha;
      if (!this.isValid(index)) {
        this.tsz[index] = 0;
        continue;
      }
      this.tx[index] = this.sx(this.sample(x, index, frame));
      this.ty[index] = this.sy(this.sample(y, index, frame));
      const turnover = this.sample(model.turnover, index, frame);
      this.tsz[index] = clamp(1.7 + (Math.log10(Math.max(1, turnover)) - 6) * 1.42, 1.8, 7.6);
      this.tchg[index] = this.sample(model.change, index, frame) / CHANGE_SCALE;
      const back = this.frameBefore(nearest, 6);
      const composite = model.factors.composite;
      this.tlive[index] = back !== null && model.valid[back * model.count + index]
        ? smoothstep(7, 15, Math.abs(composite[nearest * model.count + index]! - composite[back * model.count + index]!))
        : 0;
    }
    if (this.orderFrame !== nearest) {
      this.orderFrame = nearest;
      this.drawOrder.sort((left, right) => this.tsz[right]! - this.tsz[left]!);
    }
  }

  /** 距 frame 约 hours 小时之前的帧；找不到足够接近的帧时返回 null。 */
  private frameBefore(frame: number, hours: number) {
    const model = this.model!;
    const time = model.frameTimes[frame];
    if (time === undefined) return null;
    const target = time - hours * 3_600_000;
    let cursor = frame;
    while (cursor > 0 && model.frameTimes[cursor]! > target + 30 * 60_000) cursor -= 1;
    if (cursor === frame || Math.abs(model.frameTimes[cursor]! - target) > Math.max(90 * 60_000, hours * 3_600_000 * 0.25)) return null;
    return cursor;
  }

  private integrate(dt: number, now: number) {
    const model = this.model;
    if (!model) return;
    const tau = this.reducedMotion ? 0 : this.playing ? 0.09 : this.scrubbing ? 0.07 : 0.14;
    const k = tau ? 1 - Math.exp(-dt / tau) : 1;
    const animation = this.axisAnimation;
    for (let index = 0; index < model.count; index += 1) {
      if (animation) {
        const delay = (index % 17) * 12;
        const progress = ease(clamp((now - animation.start - delay) / 700, 0, 1));
        this.dx[index] = animation.fromX[index]! + (this.tx[index]! - animation.fromX[index]!) * progress;
        this.dy[index] = animation.fromY[index]! + (this.ty[index]! - animation.fromY[index]!) * progress;
      } else if (this.ds[index] === 0) {
        this.dx[index] = this.tx[index]!;
        this.dy[index] = this.ty[index]!;
      } else {
        this.dx[index]! += (this.tx[index]! - this.dx[index]!) * k;
        this.dy[index]! += (this.ty[index]! - this.dy[index]!) * k;
      }
      // 首次出现时星点按随机延迟逐个“点亮”。
      const born = (now - this.bootAt) / 1000 > (this.birthDelay[index] ?? 0);
      const targetSize = born ? this.tsz[index]! : 0;
      const sizeK = this.reducedMotion ? 1 : 1 - Math.exp(-dt / 0.16);
      this.ds[index]! += (targetSize - this.ds[index]!) * sizeK;
      if (this.ds[index]! < 0.05 && targetSize === 0) this.ds[index] = 0;
      this.flash[index] = this.reducedMotion ? 0 : this.flash[index]! * Math.exp(-dt / 0.7);
    }
    if (animation && now - animation.start > 900 + 17 * 12) this.axisAnimation = null;
  }

  private sweepStep(now: number) {
    const sweep = this.sweepState;
    if (!sweep) return;
    const progress = clamp((now - sweep.start) / 1400, 0, 1);
    const phi = ease(progress) * Math.PI * 2;
    sweep.phi = phi;
    sweep.fade = progress > 0.82 ? (1 - progress) / 0.18 : 1;
    const cx = (this.region.x0 + this.region.x1) / 2;
    const cy = (this.region.y0 + this.region.y1) / 2;
    for (const index of sweep.changed.keys()) {
      if (sweep.fired.has(index)) continue;
      let theta = Math.atan2(this.dx[index]! - cx, -(this.dy[index]! - cy));
      if (theta < 0) theta += Math.PI * 2;
      if (theta <= phi) {
        sweep.fired.add(index);
        this.flash[index] = 1;
        const delta = sweep.changed.get(index) ?? 0;
        if (Math.abs(delta) >= 2 && this.badges.size < 8) this.badges.set(index, { delta, at: now });
      }
    }
    if (progress >= 1) this.sweepState = null;
  }

  private drawGl() {
    const gl = this.gl;
    const model = this.model;
    if (!gl || !this.pointProgram || !this.lineProgram || !model) return;
    gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);

    // 彗尾：最近若干帧的位置（按步长取均值去抖），遇到快照空洞即截断。
    let vertices = 0;
    const current = Math.floor(this.frame);
    if (this.showTrails && !this.axisAnimation && current > 0) {
      const x = model.factors[this.xFactor];
      const y = model.factors[this.yFactor];
      const base = this.playing || this.scrubbing ? 0.55 : current < model.frames - 1 ? 0.4 : 0.25;
      // 彗尾窗口随播放速度变长；每段取步长内均值，去掉逐帧抖动，只留方向。
      const window = this.framesPerSecond <= 1 ? 12 : this.framesPerSecond <= 6 ? 36 : 72;
      const step = Math.max(1, Math.round(window / TRAIL_SEG));
      for (let index = 0; index < model.count; index += 1) {
        const alpha = this.talpha[index]!;
        if (alpha < 0.2 || this.ds[index]! < 0.5) continue;
        const rgb = changeRgb(this.tchg[index]! * CHANGE_SCALE);
        const boost = (index === this.selected || index === this.hover ? 2.4 : 1) * (0.3 + 0.7 * this.tlive[index]!);
        let px = this.dx[index]!;
        let py = this.dy[index]!;
        let pa = base * alpha * boost;
        for (let segment = 1; segment <= TRAIL_SEG; segment += 1) {
          const frame = current - (segment - 1) * step;
          if (frame < 0) break;
          if (frame < current && model.gapAfter[frame]) break;
          const key = frame * model.count + index;
          if (!model.valid[key]) break;
          let ax = 0;
          let ay = 0;
          let m = 0;
          for (let q = 0; q < step; q += 1) {
            const back = frame - q;
            if (back < 0 || (q > 0 && model.gapAfter[back])) break;
            const averaged = back * model.count + index;
            if (!model.valid[averaged]) break;
            ax += x[averaged]!;
            ay += y[averaged]!;
            m += 1;
          }
          const qx = this.sx(ax / m);
          const qy = this.sy(ay / m);
          const qa = base * alpha * boost * Math.pow(1 - segment / TRAIL_SEG, 1.6);
          const offset = vertices * 6;
          this.lineData.set([px, py, rgb[0] * pa, rgb[1] * pa, rgb[2] * pa, pa, qx, qy, rgb[0] * qa, rgb[1] * qa, rgb[2] * qa, qa], offset);
          vertices += 2;
          px = qx;
          py = qy;
          pa = qa;
        }
      }
    }
    if (vertices > 0) {
      gl.useProgram(this.lineProgram);
      gl.uniform2f(gl.getUniformLocation(this.lineProgram, "u_res"), this.width, this.height);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineData, 0, vertices * 6);
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.LINES, 0, vertices);
    }

    let points = 0;
    for (const index of this.drawOrder) {
      if (this.ds[index]! <= 0.05 || this.talpha[index]! <= 0) continue;
      const offset = points * PT_STRIDE;
      this.pointData[offset] = this.dx[index]!;
      this.pointData[offset + 1] = this.dy[index]!;
      this.pointData[offset + 2] = this.ds[index]!;
      this.pointData[offset + 3] = this.tchg[index]!;
      this.pointData[offset + 4] = this.tlive[index]! * (this.talpha[index]! > 0.5 ? 1 : 0.2);
      this.pointData[offset + 5] = this.flash[index]!;
      this.pointData[offset + 6] = this.talpha[index]!;
      this.pointData[offset + 7] = 0;
      points += 1;
    }
    gl.useProgram(this.pointProgram);
    gl.uniform2f(gl.getUniformLocation(this.pointProgram, "u_res"), this.width, this.height);
    gl.uniform1f(gl.getUniformLocation(this.pointProgram, "u_dpr"), this.dpr);
    gl.bindVertexArray(this.pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pointData, 0, points * PT_STRIDE);
    const pass = gl.getUniformLocation(this.pointProgram, "u_pass");
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(pass, 0);
    gl.drawArrays(gl.POINTS, 0, points);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(pass, 1);
    gl.drawArrays(gl.POINTS, 0, points);
    gl.bindVertexArray(null);
  }

  private drawOverlay(now: number) {
    const context = this.overlay.getContext("2d");
    const model = this.model;
    if (!context || !model) return;
    const { x0, y0, x1, y1 } = this.region;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    context.save();
    context.beginPath();
    context.rect(x0, y0, x1 - x0, y1 - y0);
    context.clip();

    // 没有 WebGL2 时退化为 2D 圆点，数据与交互不变。
    if (!this.webglAvailable) {
      for (const index of this.drawOrder) {
        if (this.ds[index]! <= 0.05 || this.talpha[index]! <= 0) continue;
        const [r, g, b] = changeRgb(this.tchg[index]! * CHANGE_SCALE);
        context.globalAlpha = this.talpha[index]!;
        context.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
        context.beginPath();
        context.arc(this.dx[index]!, this.dy[index]!, this.ds[index]!, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    }

    // 板块质心：7 天位移显著的板块画平滑弧线（按时间淡出，每天一个刻点），其余只留小标记。
    const centroids = this.showCentroids && !this.axisAnimation ? this.centroids() : [];
    for (const centroid of centroids) {
      if (!centroid.moving) {
        context.globalAlpha = 0.55;
        context.strokeStyle = INK.ink3;
        context.lineWidth = 1;
        context.beginPath();
        context.arc(centroid.x, centroid.y, 2.5, 0, Math.PI * 2);
        context.stroke();
        context.globalAlpha = 1;
        continue;
      }
      const path = centroid.path;
      const length = path.length;
      context.lineWidth = 1.3;
      context.lineCap = "round";
      context.strokeStyle = INK.ink;
      for (let k = 0; k < length - 1; k += 1) {
        const p0 = path[Math.max(0, k - 1)]!;
        const p1 = path[k]!;
        const p2 = path[k + 1]!;
        const p3 = path[Math.min(length - 1, k + 2)]!;
        const age = 1 - (k + 1) / (length - 1);
        context.globalAlpha = 0.05 + 0.6 * Math.pow(1 - age, 1.6);
        context.beginPath();
        context.moveTo(p1[0], p1[1]);
        context.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
        context.stroke();
      }
      context.fillStyle = INK.ink;
      for (let k = length - 5; k >= 0; k -= 4) {
        context.globalAlpha = 0.1 + 0.5 * (k / (length - 1));
        context.beginPath();
        context.arc(path[k]![0], path[k]![1], 1.3, 0, Math.PI * 2);
        context.fill();
      }
      context.lineCap = "butt";
      context.globalAlpha = 1;
      context.lineWidth = 1.2;
      context.beginPath();
      context.moveTo(centroid.x - 5, centroid.y);
      context.lineTo(centroid.x - 2, centroid.y);
      context.moveTo(centroid.x + 2, centroid.y);
      context.lineTo(centroid.x + 5, centroid.y);
      context.moveTo(centroid.x, centroid.y - 5);
      context.lineTo(centroid.x, centroid.y - 2);
      context.moveTo(centroid.x, centroid.y + 2);
      context.lineTo(centroid.x, centroid.y + 5);
      context.stroke();
    }

    // 选中：到坐标轴的辅助线 + 7 天路径（每天一个刻点）。
    const frame = Math.round(this.frame);
    const selected = this.selected;
    const x = model.factors[this.xFactor];
    const y = model.factors[this.yFactor];
    if (selected >= 0 && this.ds[selected]! > 0.3) {
      const sxp = this.dx[selected]!;
      const syp = this.dy[selected]!;
      context.setLineDash([2, 3]);
      context.strokeStyle = INK.ink3;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(sxp, syp);
      context.lineTo(sxp, y1);
      context.moveTo(sxp, syp);
      context.lineTo(x0, syp);
      context.stroke();
      context.setLineDash([]);
      const start = model.frameTimes[frame]!;
      context.strokeStyle = INK.ink;
      context.globalAlpha = 0.45;
      context.beginPath();
      context.moveTo(sxp, syp);
      for (let back = frame - 1; back >= 0; back -= 1) {
        if (start - model.frameTimes[back]! > 7 * 86_400_000 || model.gapAfter[back]) break;
        const key = back * model.count + selected;
        if (!model.valid[key]) break;
        context.lineTo(this.sx(x[key]!), this.sy(y[key]!));
      }
      context.stroke();
      context.globalAlpha = 1;
      for (let day = 1; day <= 7; day += 1) {
        const back = this.frameBefore(frame, day * 24);
        if (back === null) break;
        const key = back * model.count + selected;
        if (!model.valid[key]) break;
        context.fillStyle = INK.ink2;
        context.globalAlpha = 1 - day / 9;
        context.beginPath();
        context.arc(this.sx(x[key]!), this.sy(y[key]!), 1.6, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    }

    // 环：比较（序列色）/ 选中 / 悬停。
    const ring = (index: number, color: string, width: number, gap: number) => {
      if (index < 0 || this.ds[index]! < 0.3) return;
      context.strokeStyle = color;
      context.lineWidth = width;
      context.beginPath();
      context.arc(this.dx[index]!, this.dy[index]!, this.ds[index]! + gap, 0, Math.PI * 2);
      context.stroke();
    };
    this.compare.forEach((index, position) => ring(index, COMPARE_SERIES[position % COMPARE_SERIES.length]!, 1.5, 4));
    if (selected >= 0) ring(selected, INK.ink, 1.5, 4);
    if (this.hover >= 0 && this.hover !== selected) ring(this.hover, INK.ink2, 1, 3.5);

    // 标签：比较 / 选中 / 悬停必显，其次移动中的板块质心、扫描徽标、综合名次前 10，统一避让。
    type LabelItem = { index: number; priority: number; force: boolean; far: boolean; x: number; y: number; r: number; text: string; sub: string; badge: string; font: string; color: string; centroid: boolean; lineHeight: number };
    const items: LabelItem[] = [];
    const seen = new Set<number>();
    const push = (index: number, priority: number, force: boolean, color: string) => {
      if (index < 0 || seen.has(index) || this.ds[index]! < 0.6 || this.talpha[index]! < 0.3) return;
      seen.add(index);
      const badge = this.badges.get(index);
      items.push({
        index, priority, force, far: false, x: this.dx[index]!, y: this.dy[index]!, r: this.ds[index]!,
        text: model.labels[index]!, sub: `#${model.rank[frame * model.count + index]}`,
        badge: badge ? `${badge.delta > 0 ? "▲" : "▼"}${Math.abs(badge.delta)}` : "",
        font: `600 11px ${UI_FONT}`, color, centroid: false, lineHeight: 12
      });
    };
    this.compare.forEach((index, position) => push(index, 0, true, COMPARE_SERIES[position % COMPARE_SERIES.length]!));
    push(selected, 0, true, INK.ink);
    push(this.hover, 0, true, INK.ink);
    for (const centroid of centroids) {
      const name = this.categoryNames[centroid.category] ?? centroid.category;
      items.push(centroid.moving
        ? { index: -1, priority: 0.5, force: true, far: true, x: centroid.x, y: centroid.y, r: 6, text: name, sub: "", badge: "", font: `600 11px ${UI_FONT}`, color: INK.ink, centroid: true, lineHeight: 12 }
        : { index: -1, priority: 5, force: false, far: false, x: centroid.x, y: centroid.y, r: 4, text: name, sub: "", badge: "", font: `500 10px ${UI_FONT}`, color: INK.ink4, centroid: true, lineHeight: 11 });
    }
    const order: number[] = [];
    for (let index = 0; index < model.count; index += 1) if (model.valid[frame * model.count + index] && this.talpha[index]! > 0.5) order.push(index);
    order.sort((left, right) => model.rank[frame * model.count + left]! - model.rank[frame * model.count + right]!);
    const topN = this.focusMask ? 14 : 10;
    for (const index of order.slice(0, topN)) push(index, 2, false, INK.ink2);
    for (const index of this.badges.keys()) push(index, 1.5, false, INK.ink2);
    items.sort((left, right) => left.priority - right.priority);

    const boxes = centroids.map((centroid) => ({ x: centroid.x - 6, y: centroid.y - 6, w: 12, h: 12 }));
    const inside = (box: { x: number; y: number; w: number; h: number }) => box.x >= x0 + 2 && box.y >= y0 + 2 && box.x + box.w <= x1 - 2 && box.y + box.h <= y1 - 2;
    const hit = (box: { x: number; y: number; w: number; h: number }) => boxes.some((other) => box.x < other.x + other.w && box.x + box.w > other.x && box.y < other.y + other.h && box.y + box.h > other.y);
    const placed: Array<LabelItem & { bx: number; by: number; w: number; h: number; leader: boolean }> = [];
    for (const item of items) {
      context.font = item.font;
      let width = context.measureText(item.text).width;
      if (item.sub || item.badge) {
        context.font = `10px ${NUM_FONT}`;
        width += context.measureText(` ${item.sub}${item.badge ? `  ${item.badge}` : ""}`).width + 2;
      }
      const height = item.lineHeight;
      const gap = item.r + 4;
      const candidates: Array<[number, number]> = [
        [item.x + gap, item.y - height / 2], [item.x - gap - width, item.y - height / 2],
        [item.x - width / 2, item.y - gap - height], [item.x - width / 2, item.y + gap],
        [item.x + gap * 0.8, item.y - gap - height * 0.8], [item.x - gap * 0.8 - width, item.y + gap * 0.6]
      ];
      const near = candidates.length;
      if (item.far) {
        for (const distance of [26, 44]) {
          candidates.push([item.x + distance, item.y - distance * 0.75 - height], [item.x - distance - width, item.y - distance * 0.75 - height], [item.x + distance, item.y + distance * 0.6], [item.x - distance - width, item.y + distance * 0.6]);
        }
      }
      let done = false;
      for (let position = 0; position < candidates.length; position += 1) {
        const [bx, by] = candidates[position]!;
        const box = { x: bx - 2, y: by - 1, w: width + 4, h: height + 2 };
        if (!inside(box) || hit(box)) continue;
        boxes.push(box);
        placed.push({ ...item, bx, by, w: width, h: height, leader: position >= near });
        done = true;
        break;
      }
      if (!done && item.force) {
        const [bx, by] = candidates.find(([cx, cy]) => inside({ x: cx - 2, y: cy - 1, w: width + 4, h: height + 2 })) ?? candidates[0]!;
        boxes.push({ x: bx - 2, y: by - 1, w: width + 4, h: height + 2 });
        placed.push({ ...item, bx, by, w: width, h: height, leader: false });
      }
    }
    context.textBaseline = "top";
    context.textAlign = "left";
    for (const label of placed) {
      if (label.leader) {
        const tx = clamp(label.x, label.bx - 2, label.bx + label.w + 2);
        const ty = clamp(label.y, label.by - 1, label.by + label.h + 1);
        context.strokeStyle = INK.ink3;
        context.lineWidth = 1;
        context.globalAlpha = 0.7;
        context.beginPath();
        context.moveTo(label.x, label.y);
        context.lineTo(tx, ty);
        context.stroke();
        context.globalAlpha = 1;
      }
      context.font = label.font;
      if (!label.centroid || label.far) {
        context.globalAlpha = 0.85;
        context.fillStyle = INK.bg;
        context.fillRect(label.bx - 2, label.by - 1, label.w + 4, 14);
        context.globalAlpha = 1;
      }
      context.fillStyle = label.color;
      context.fillText(label.text, label.bx, label.by);
      if (label.sub) {
        const textWidth = context.measureText(label.text).width;
        context.font = `10px ${NUM_FONT}`;
        context.fillStyle = INK.ink4;
        context.fillText(label.sub, label.bx + textWidth + 4, label.by + 1);
        if (label.badge) {
          const badge = this.badges.get(label.index);
          const age = badge ? (now - badge.at) / 1000 : 9;
          context.globalAlpha = age < 1.6 ? 1 : Math.max(0, 1 - (age - 1.6));
          context.fillStyle = INK.live;
          context.fillText(label.badge, label.bx + textWidth + 4 + context.measureText(`${label.sub} `).width + 4, label.by + 1);
          context.globalAlpha = 1;
        }
      }
    }
    for (const [index, badge] of this.badges) if ((now - badge.at) / 1000 > 2.6) this.badges.delete(index);

    // 雷达扫描（一次性，只在实时刷新时出现）。
    const sweep = this.sweepState;
    if (sweep) {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const radius = Math.hypot(x1 - x0, y1 - y0) / 2;
      const lead = sweep.phi - Math.PI / 2;
      const span = 0.7;
      const slices = 28;
      context.fillStyle = INK.live;
      for (let slice = 0; slice < slices; slice += 1) {
        const a1 = lead - (slice / slices) * span;
        const a0 = lead - ((slice + 1) / slices) * span;
        context.globalAlpha = 0.13 * sweep.fade * Math.pow(1 - slice / slices, 1.6);
        context.beginPath();
        context.moveTo(cx, cy);
        context.arc(cx, cy, radius, a0, a1);
        context.closePath();
        context.fill();
      }
      context.globalAlpha = 0.55 * sweep.fade;
      context.strokeStyle = INK.live;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(cx, cy);
      context.lineTo(cx + Math.cos(lead) * radius, cy + Math.sin(lead) * radius);
      context.stroke();
      context.globalAlpha = 1;
    }

    if (this.lasso && this.lasso.length > 1) {
      context.beginPath();
      this.lasso.forEach(([lx, ly], position) => (position === 0 ? context.moveTo(lx, ly) : context.lineTo(lx, ly)));
      context.closePath();
      context.fillStyle = INK.ink;
      context.globalAlpha = 0.05;
      context.fill();
      context.globalAlpha = 0.8;
      context.setLineDash([3, 3]);
      context.strokeStyle = INK.ink2;
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
    }
    context.restore();

    // 坐标轴读数（选中时）。
    if (selected >= 0 && this.ds[selected]! > 0.3) {
      const xv = this.sample(x, selected, this.frame);
      const yv = this.sample(y, selected, this.frame);
      context.font = `10px ${NUM_FONT}`;
      const tag = (label: string, tx: number, ty: number, axis: "x" | "y") => {
        const width = context.measureText(label).width + 8;
        const bx = axis === "x" ? tx - width / 2 : tx - width;
        context.fillStyle = INK.ink;
        context.fillRect(bx, ty - 8, width, 16);
        context.fillStyle = INK.bg;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(label, bx + width / 2, ty);
      };
      tag(xv.toFixed(0), this.dx[selected]!, y1 + 13, "x");
      tag(yv.toFixed(0), x0 - 4, this.dy[selected]!, "y");
    }
  }

  // 板块质心：当前位置 + 7 天路径（每 6 小时一个样本，EMA 平滑去掉逐小时抖动），
  // 只有 7 天位移显著的前 3 个板块（或被聚焦的板块）画轨迹。
  private centroids() {
    const model = this.model!;
    const frame = Math.round(this.frame);
    const x = model.factors[this.xFactor];
    const y = model.factors[this.yFactor];
    const diagonal = Math.hypot(this.region.x1 - this.region.x0, this.region.y1 - this.region.y0);
    const out: Array<{ category: string; x: number; y: number; path: Array<[number, number]>; displacement: number; moving: boolean }> = [];
    for (const category of model.sectors) {
      if (this.hiddenCategories.has(category) || category === "other") continue;
      let count = 0;
      let cx = 0;
      let cy = 0;
      for (let index = 0; index < model.count; index += 1) {
        if (model.categories[index] !== category || this.ds[index]! < 0.3) continue;
        cx += this.dx[index]!;
        cy += this.dy[index]!;
        count += 1;
      }
      if (count < 3) continue;
      cx /= count;
      cy /= count;
      const raw: Array<[number, number]> = [];
      for (let back = 28; back >= 1; back -= 1) {
        const cursor = this.frameBefore(frame, back * 6);
        if (cursor === null) continue;
        let m = 0;
        let ax = 0;
        let ay = 0;
        for (let index = 0; index < model.count; index += 1) {
          const key = cursor * model.count + index;
          if (model.categories[index] !== category || !model.valid[key]) continue;
          ax += x[key]!;
          ay += y[key]!;
          m += 1;
        }
        if (m > 0) raw.push([this.sx(ax / m), this.sy(ay / m)]);
      }
      raw.push([cx, cy]);
      const path: Array<[number, number]> = [];
      let ex = raw[0]![0];
      let ey = raw[0]![1];
      for (const [px, py] of raw) {
        ex += (px - ex) * 0.26;
        ey += (py - ey) * 0.26;
        path.push([ex, ey]);
      }
      path[path.length - 1] = [cx, cy];
      const displacement = (Math.hypot(cx - path[0]![0], cy - path[0]![1]) / diagonal) * 100;
      out.push({ category, x: cx, y: cy, path, displacement, moving: false });
    }
    out.filter((item) => item.displacement > 5.5 && item.path.length > 4).sort((left, right) => right.displacement - left.displacement).slice(0, 3).forEach((item) => { item.moving = true; });
    for (const item of out) if (this.categoryFocus === item.category && item.path.length > 4) item.moving = true;
    return out;
  }

  private pick(x: number, y: number) {
    const model = this.model;
    if (!model) return -1;
    let best = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < model.count; index += 1) {
      if (this.talpha[index]! < 0.3 || this.ds[index]! < 0.4) continue;
      const distance = Math.hypot(this.dx[index]! - x, this.dy[index]! - y);
      if (distance < Math.max(7, this.ds[index]! + 4) && distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  }

  private bindPointer() {
    const surface = this.overlay;
    const local = (event: PointerEvent): [number, number] => {
      const rect = surface.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };
    surface.addEventListener("pointerdown", (event) => {
      if (!event.shiftKey) return;
      event.preventDefault();
      surface.setPointerCapture(event.pointerId);
      this.lasso = [local(event)];
      this.hover = -1;
      this.callbacks.onHover(null, 0, 0);
    });
    surface.addEventListener("pointermove", (event) => {
      if (this.lasso) {
        this.lasso.push(local(event));
        return;
      }
      const [x, y] = local(event);
      const index = this.pick(x, y);
      if (index !== this.hover) {
        this.hover = index;
        surface.style.cursor = index >= 0 ? "pointer" : "default";
      }
      this.callbacks.onHover(index >= 0 ? index : null, event.clientX, event.clientY);
    });
    surface.addEventListener("pointerleave", () => {
      this.hover = -1;
      this.callbacks.onHover(null, 0, 0);
    });
    surface.addEventListener("pointerup", (event) => {
      if (this.lasso) {
        const polygon = this.lasso;
        this.lasso = null;
        if (polygon.length > 3) this.callbacks.onLasso(this.pointsInside(polygon));
        return;
      }
      const [x, y] = local(event);
      const index = this.pick(x, y);
      if (index >= 0 && (event.metaKey || event.ctrlKey)) this.callbacks.onToggleCompare(index);
      else this.callbacks.onSelect(index);
    });
  }

  private pointsInside(polygon: Array<[number, number]>) {
    const model = this.model!;
    const inside: number[] = [];
    for (let index = 0; index < model.count; index += 1) {
      if (this.talpha[index]! < 0.3 || this.ds[index]! < 0.4) continue;
      const px = this.dx[index]!;
      const py = this.dy[index]!;
      let hit = false;
      for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a, a += 1) {
        const [ax, ay] = polygon[a]!;
        const [bx, by] = polygon[b]!;
        if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) hit = !hit;
      }
      if (hit) inside.push(index);
    }
    return inside;
  }
}
