import type { ConstellationFactor, ConstellationModel } from "./constellationModel";
import { rankChangeOver } from "./constellationModel";

// 市场星图渲染引擎（与 React 解耦）：网格层（2D）+ 星点 / 彗尾层（WebGL2）+ 叠加层（2D：质心、标签、扫描、套索）。
// 颜色只表达 24h 涨跌（红涨绿跌），点大小 = 成交额，光晕只给近 6 小时综合名次显著变化的合约（活数据）。

export type AxisLabels = { x: string; y: string; xLow: string; xHigh: string; yLow: string; yHigh: string };

export type EngineCallbacks = {
  onHover: (index: number | null, clientX: number, clientY: number) => void;
  onSelect: (index: number) => void;
  onLasso: (indices: number[]) => void;
  onTime: (frame: number, playing: boolean) => void;
};

const PAD = { left: 50, right: 22, top: 26, bottom: 40 };
const PT_STRIDE = 8;
const TRAIL_SEG = 14;
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
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [this.grid, this.glCanvas, this.overlay]) {
      canvas.width = Math.round(this.width * this.dpr);
      canvas.height = Math.round(this.height * this.dpr);
    }
    this.region = { x0: PAD.left, y0: PAD.top, x1: this.width - PAD.right, y1: this.height - PAD.bottom };
    this.drawGrid();
  }

  private sx(value: number) {
    return this.region.x0 + (value / 100) * (this.region.x1 - this.region.x0);
  }

  private sy(value: number) {
    return this.region.y1 - (value / 100) * (this.region.y1 - this.region.y0);
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
    for (let value = 0; value <= 100; value += 10) {
      const x = Math.round(this.sx(value)) + 0.5;
      const y = Math.round(this.sy(value)) + 0.5;
      context.strokeStyle = value === 50 ? hairStrong : hair;
      context.globalAlpha = value % 25 !== 0 && value % 50 !== 0 ? 0.45 : 1;
      context.setLineDash(value === 50 ? [2, 4] : []);
      context.beginPath();
      context.moveTo(x, y0);
      context.lineTo(x, y1);
      context.moveTo(x0, y);
      context.lineTo(x1, y);
      context.stroke();
      context.globalAlpha = 1;
      if (value % 25 === 0) {
        context.fillStyle = weak;
        context.textAlign = "center";
        context.textBaseline = "top";
        context.fillText(String(value), x, y1 + 7);
        context.textAlign = "right";
        context.textBaseline = "middle";
        context.fillText(String(value), x0 - 8, y);
      }
    }
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
      const delta = rankChangeOver(model, index, nearest, 6);
      this.tlive[index] = delta === null ? 0 : smoothstep(8, 30, Math.abs(delta));
    }
    if (this.orderFrame !== nearest) {
      this.orderFrame = nearest;
      this.drawOrder.sort((left, right) => this.tsz[right]! - this.tsz[left]!);
    }
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
      const sizeK = this.reducedMotion ? 1 : 1 - Math.exp(-dt / 0.16);
      this.ds[index]! += (this.tsz[index]! - this.ds[index]!) * sizeK;
      if (this.ds[index]! < 0.05 && this.tsz[index] === 0) this.ds[index] = 0;
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
    if (!this.axisAnimation && current > 0) {
      const x = model.factors[this.xFactor];
      const y = model.factors[this.yFactor];
      const base = this.playing || this.scrubbing ? 0.55 : current < model.frames - 1 ? 0.4 : 0.25;
      const step = this.playing && this.framesPerSecond > 6 ? 3 : 1;
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
          const qx = this.sx(x[key]!);
          const qy = this.sy(y[key]!);
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
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    const text = this.token("--text", "#f4f4fa");
    const weak = this.token("--weak", "#6e7187");
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

    this.drawCentroids(context, weak);

    // 雷达扫描：一次性扫过，只在刷新时出现。
    const sweep = this.sweepState;
    if (sweep) {
      const cx = (this.region.x0 + this.region.x1) / 2;
      const cy = (this.region.y0 + this.region.y1) / 2;
      const radius = Math.hypot(this.region.x1 - this.region.x0, this.region.y1 - this.region.y0) / 2;
      const gradient = context.createConicGradient(sweep.phi - Math.PI / 2 - 0.5, cx, cy);
      gradient.addColorStop(0, "rgba(95, 212, 224, 0)");
      gradient.addColorStop(0.08, `rgba(95, 212, 224, ${0.1 * sweep.fade})`);
      gradient.addColorStop(0.0801, "rgba(95, 212, 224, 0)");
      context.save();
      context.beginPath();
      context.rect(this.region.x0, this.region.y0, this.region.x1 - this.region.x0, this.region.y1 - this.region.y0);
      context.clip();
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }

    // 标签：综合名次前 10 + 选中 / 比较 / 悬停，做碰撞避让。
    const frame = Math.round(this.frame);
    const candidates: number[] = [];
    const ranked: Array<[number, number]> = [];
    for (let index = 0; index < model.count; index += 1) {
      if (this.talpha[index]! < 0.5 || this.ds[index]! < 0.5) continue;
      ranked.push([model.rank[frame * model.count + index]!, index]);
    }
    ranked.sort((left, right) => left[0] - right[0]);
    for (const [, index] of ranked.slice(0, 10)) candidates.push(index);
    const forced = new Set([this.selected, this.hover, ...this.compare].filter((index) => index >= 0));
    for (const index of forced) if (!candidates.includes(index)) candidates.unshift(index);
    const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    context.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    context.textBaseline = "top";
    for (const index of [...candidates].sort((left, right) => Number(forced.has(right)) - Number(forced.has(left)))) {
      const label = model.labels[index]!;
      const rank = model.rank[frame * model.count + index]!;
      const detail = ` #${rank}`;
      const width = context.measureText(label).width + context.measureText(detail).width + 4;
      const x = this.dx[index]!;
      const y = this.dy[index]!;
      const gap = this.ds[index]! + 4;
      const spots: Array<[number, number]> = [[x + gap, y - 6], [x - gap - width, y - 6], [x - width / 2, y - gap - 13], [x - width / 2, y + gap]];
      const spot = spots.find(([sx, sy]) => sx > this.region.x0 && sx + width < this.region.x1 && sy > this.region.y0 && sy + 13 < this.region.y1
        && !boxes.some((box) => sx < box.x + box.w && sx + width > box.x && sy < box.y + box.h && sy + 13 > box.y))
        ?? (forced.has(index) ? spots[0] : null);
      if (!spot) continue;
      boxes.push({ x: spot[0] - 2, y: spot[1] - 1, w: width + 4, h: 15 });
      context.fillStyle = forced.has(index) ? text : "rgba(240, 240, 248, 0.82)";
      context.fillText(label, spot[0], spot[1]);
      context.fillStyle = weak;
      context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.fillText(detail, spot[0] + context.measureText(label).width + 2, spot[1] + 1);
      context.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      if (forced.has(index)) {
        context.strokeStyle = "rgba(240, 240, 248, 0.7)";
        context.lineWidth = 1;
        context.beginPath();
        context.arc(x, y, this.ds[index]! + 3, 0, Math.PI * 2);
        context.stroke();
      }
    }

    if (this.lasso && this.lasso.length > 1) {
      context.strokeStyle = "rgba(240, 240, 248, 0.6)";
      context.setLineDash([4, 3]);
      context.fillStyle = "rgba(240, 240, 248, 0.04)";
      context.beginPath();
      this.lasso.forEach(([lx, ly], position) => (position === 0 ? context.moveTo(lx, ly) : context.lineTo(lx, ly)));
      context.closePath();
      context.fill();
      context.stroke();
      context.setLineDash([]);
    }
    void now;
  }

  // 类别质心：7 天路径（每 6 小时一个样本）EMA 平滑，只有位移显著的类别画轨迹。
  private drawCentroids(context: CanvasRenderingContext2D, weak: string) {
    const model = this.model!;
    const frame = Math.round(this.frame);
    const categories = [...new Set(model.categories)];
    if (categories.length < 2) return;
    const x = model.factors[this.xFactor];
    const y = model.factors[this.yFactor];
    const diagonal = Math.hypot(this.region.x1 - this.region.x0, this.region.y1 - this.region.y0);
    const labelBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const category of categories) {
      if (this.hiddenCategories.has(category)) continue;
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
      const path: Array<[number, number]> = [];
      const time = model.frameTimes[frame]!;
      for (let back = 28; back >= 1; back -= 1) {
        const target = time - back * 6 * 3_600_000;
        let cursor = frame;
        while (cursor > 0 && model.frameTimes[cursor]! > target) cursor -= 1;
        if (Math.abs(model.frameTimes[cursor]! - target) > 3 * 3_600_000) continue;
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
        if (m > 0) path.push([this.sx(ax / m), this.sy(ay / m)]);
      }
      path.push([cx, cy]);
      const smoothed: Array<[number, number]> = [];
      let ex = path[0]![0];
      let ey = path[0]![1];
      for (const [px, py] of path) {
        ex += (px - ex) * 0.26;
        ey += (py - ey) * 0.26;
        smoothed.push([ex, ey]);
      }
      smoothed[smoothed.length - 1] = [cx, cy];
      const displacement = (Math.hypot(cx - smoothed[0]![0], cy - smoothed[0]![1]) / diagonal) * 100;
      if (displacement > 5.5 && smoothed.length > 2) {
        context.strokeStyle = "rgba(240, 240, 248, 0.45)";
        context.lineWidth = 1.2;
        context.beginPath();
        smoothed.forEach(([px, py], position) => (position === 0 ? context.moveTo(px, py) : context.lineTo(px, py)));
        context.stroke();
      }
      context.strokeStyle = "rgba(240, 240, 248, 0.75)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(cx - 4, cy);
      context.lineTo(cx + 4, cy);
      context.moveTo(cx, cy - 4);
      context.lineTo(cx, cy + 4);
      context.stroke();
      context.fillStyle = weak;
      context.font = "10px ui-sans-serif, system-ui, sans-serif";
      context.textBaseline = "bottom";
      const name = this.categoryNames[category] ?? category;
      const width = context.measureText(name).width;
      // 质心名称互相避让：依次尝试右上、右下、左上、左下，全部冲突则不画名称（十字标记保留）。
      const spot = ([[cx + 6, cy - 3], [cx + 6, cy + 14], [cx - 6 - width, cy - 3], [cx - 6 - width, cy + 14]] as Array<[number, number]>)
        .find(([lx, ly]) => !labelBoxes.some((box) => lx < box.x + box.w && lx + width > box.x && ly - 12 < box.y + box.h && ly > box.y));
      if (spot) {
        labelBoxes.push({ x: spot[0], y: spot[1] - 12, w: width, h: 12 });
        context.fillText(name, spot[0], spot[1]);
      }
    }
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
      if (index >= 0) this.callbacks.onSelect(index);
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
