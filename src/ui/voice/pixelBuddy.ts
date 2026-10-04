/**
 * 语音伙伴的像素引擎：一个方块机器人。所有绘制都落在整数像素网格上，角色以 12fps 刷新，
 * 运动是「一蹦一蹦」的跳跃加落地尘土，指挥界面时会射出一串像素飞向目标元素。
 *
 * 引擎不依赖 React：组件只负责把状态（阶段、音量、进度）喂进来。
 * 性能：只在需要动的时候跑 requestAnimationFrame（醒着、移动、冒头、有粒子）；
 * 睡在边缘时只在状态变化时画一帧，不空转。
 */

export type BuddyPhase =
  | "sleeping"
  | "listening"
  | "thinking"
  | "confirming"
  | "working"
  | "talking"
  | "happy"
  | "refuse"
  | "nod";

export type BuddyPalette = { light: string; base: string; shade: string; eye: string; tip: string; soft: string };

export const BUDDY_PALETTES = {
  violet: { light: "#b9a2ff", base: "#8f5cff", shade: "#5a34b8", eye: "#0c0818", tip: "#e6dcff", soft: "#6f58c8" },
  orange: { light: "#ec9a74", base: "#d97757", shade: "#a64e33", eye: "#1b0d08", tip: "#ffd7c4", soft: "#b5654a" },
  mono: { light: "#f3f4f8", base: "#cdd1db", shade: "#8a90a1", eye: "#0b0d12", tip: "#ffffff", soft: "#9aa0b0" },
} satisfies Record<string, BuddyPalette>;
export type BuddyPaletteName = keyof typeof BUDDY_PALETTES;

const ACCENT = { amber: "#f5a524", green: "#7edba9", red: "#f2808c" };
/** 一个像素单元对应的 CSS 像素。 */
export const BUDDY_UNIT = 6;
/** 画布边长（CSS 像素）。 */
export const BUDDY_BOX = 220;
const CENTER = BUDDY_BOX / 2;

const BODY_ROWS = ["..XXXXXXXX..", "XXXXXXXXXXXX", "XXXXXXXXXXXX", "XXXXXXXXXXXX", "XXXXXXXXXXXX", "XXXXXXXXXXXX", "XXXXXXXXXXXX", "XXXXXXXXXXXX", ".XXXXXXXXXX."];

type Point = { x: number; y: number };
type Dust = { x: number; y: number; vx: number; vy: number; life: number; age: number };
type Beam = { from: Point; to: Point; t: number; dur: number; delay: number; arc: number; arrived: boolean; onArrive?: () => void };

export type PixelBuddyOptions = {
  canvas: HTMLCanvasElement;
  trail: HTMLCanvasElement;
  /** 随角色一起移动的容器（左上角 = 画布左上角）。 */
  root: HTMLElement;
  reducedMotion: boolean;
};

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export class PixelBuddy {
  private readonly canvas: HTMLCanvasElement;
  private readonly trail: HTMLCanvasElement;
  private readonly root: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tctx: CanvasRenderingContext2D;
  private readonly reduced: boolean;
  private dpr = 1;
  private palette: BuddyPalette = BUDDY_PALETTES.violet;
  private side: "left" | "right" = "right";
  private phase: BuddyPhase = "sleeping";
  private phaseSince = 0;
  private level = 0;
  private levelTarget = 0;
  private progress = 0;
  private progressTarget = 0;
  private awake = false;
  private airborne = false;
  private squash = 0;
  private blink = 0;
  private facing: 1 | -1 = -1;
  private lookTarget: Point = { x: 0, y: 0 };
  private look: Point = { x: 0, y: 0 };
  private pos: Point = { x: -9999, y: 0 };
  private dust: Dust[] = [];
  private beams: Beam[] = [];
  private raf = 0;
  private lastDraw = 0;
  private lastTick = 0;
  private moving = false;
  /** 每次新的移动递增；旧的移动循环发现令牌过期就立刻退出，避免两段动画抢位置。 */
  private moveId = 0;
  private peeking = false;
  private destroyed = false;
  /** 倒计时进度条的归一化值（1 = 满，0 = 到点）。 */
  private countdown: number | null = null;
  private previewTimers: number[] = [];

  constructor(options: PixelBuddyOptions) {
    this.canvas = options.canvas;
    this.trail = options.trail;
    this.root = options.root;
    this.reduced = options.reducedMotion;
    const ctx = this.canvas.getContext("2d");
    const tctx = this.trail.getContext("2d");
    if (!ctx || !tctx) throw new Error("canvas unsupported");
    this.ctx = ctx;
    this.tctx = tctx;
    this.resize();
    this.placeDocked("hidden");
    this.requestFrame();
  }

  // ───────────── 外部状态 ─────────────
  setPalette(name: BuddyPaletteName) {
    this.palette = BUDDY_PALETTES[name];
    this.requestFrame();
  }

  setSide(side: "left" | "right") {
    if (this.side === side) return;
    this.side = side;
    this.facing = side === "right" ? -1 : 1;
    if (!this.awake && !this.moving) this.placeDocked("hidden");
    this.requestFrame();
  }

  setPhase(phase: BuddyPhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseSince = performance.now() / 1000;
    this.requestFrame();
  }

  setLevel(value: number) {
    this.levelTarget = Math.max(0, Math.min(1, value));
    if (this.phase === "listening") this.requestFrame();
  }

  setProgress(value: number) {
    this.progressTarget = Math.max(0, Math.min(1, value));
    this.requestFrame();
  }

  setCountdown(value: number | null) {
    this.countdown = value;
    this.requestFrame();
  }

  /** 看向屏幕上的一点（鼠标位置）。视线只取整数格，像素风不做平滑。 */
  lookAt(clientX: number, clientY: number) {
    const dx = clientX - this.pos.x;
    const dy = clientY - this.pos.y;
    const distance = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, distance / 260);
    this.lookTarget = { x: (dx / distance) * k, y: (dy / distance) * k };
    if (this.awake) this.requestFrame();
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.canvas.height = BUDDY_BOX * this.dpr;
    this.trail.width = window.innerWidth;
    this.trail.height = window.innerHeight;
    if (!this.awake && !this.moving) this.placeDocked("hidden");
    else if (this.awake && !this.moving) this.place(this.awakeCenter());
  }

  /** 设置页预览：原地循环几个表情，不跳跃、不冒头；听写表情时用假的音量让嘴和声波动起来。 */
  startPreview(cycle: BuddyPhase[] = ["nod", "listening", "thinking", "happy"], everyMs = 1900) {
    this.awake = true;
    this.facing = 1;
    this.place({ x: CENTER, y: CENTER });
    let index = 0;
    const next = () => {
      this.setPhase(cycle[index % cycle.length]);
      index += 1;
    };
    next();
    this.previewTimers.push(window.setInterval(next, everyMs));
    this.previewTimers.push(window.setInterval(() => this.setLevel(this.phase === "listening" ? 0.25 + Math.random() * 0.6 : 0), 110));
    this.requestFrame();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.previewTimers.forEach((timer) => window.clearInterval(timer));
    this.previewTimers = [];
  }

  // ───────────── 位置 ─────────────
  private dockCenter(kind: "hidden" | "peek"): Point {
    const y = Math.round(window.innerHeight * 0.58);
    const half = 6 * BUDDY_UNIT;
    const visible = kind === "hidden" ? BUDDY_UNIT : Math.round(6.5 * BUDDY_UNIT);
    return { x: this.side === "right" ? window.innerWidth - visible + half : visible - half, y };
  }

  private awakeCenter(): Point {
    return { x: Math.round(window.innerWidth / 2), y: window.innerHeight - 100 };
  }

  private place(point: Point, lift = 0) {
    this.pos = point;
    const snap = (value: number) => Math.round(value * this.dpr) / this.dpr;
    this.root.style.transform = `translate(${snap(point.x - CENTER)}px,${snap(point.y - CENTER - lift)}px)`;
  }

  private placeDocked(kind: "hidden" | "peek") {
    this.facing = this.side === "right" ? -1 : 1;
    this.place(this.dockCenter(kind));
  }

  private async tween(duration: number, step: (progress: number) => void, token: number = this.moveId): Promise<boolean> {
    const started = performance.now();
    for (;;) {
      if (this.destroyed || token !== this.moveId) return false;
      const progress = Math.min(1, (performance.now() - started) / duration);
      step(progress);
      if (progress >= 1) return true;
      await nextFrame();
    }
  }

  /** 一蹦一蹦地跳到目标点，落地压扁一格并扬起像素尘土。被新的移动取代时返回 false。 */
  private async travel(to: Point, token: number): Promise<boolean> {
    if (this.reduced) {
      this.place(to);
      return true;
    }
    this.moving = true;
    this.requestFrame();
    const from = { ...this.pos };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (to.x !== from.x) this.facing = to.x > from.x ? 1 : -1;
    const hops = Math.max(1, Math.round(distance / 380));
    for (let index = 0; index < hops; index += 1) {
      const a = { x: from.x + ((to.x - from.x) * index) / hops, y: from.y + ((to.y - from.y) * index) / hops };
      const b = { x: from.x + ((to.x - from.x) * (index + 1)) / hops, y: from.y + ((to.y - from.y) * (index + 1)) / hops };
      this.airborne = true;
      const completed = await this.tween(260, (u) => this.place({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, Math.sin(u * Math.PI) * 46), token);
      this.airborne = false;
      if (!completed) return false;
      this.squash = 0.12;
      this.place(b);
      this.puff(b.x, b.y + 5 * BUDDY_UNIT, 6);
      await sleep(index === hops - 1 ? 30 : 60);
      if (token !== this.moveId) return false;
    }
    this.squash = 0;
    this.moving = false;
    this.requestFrame();
    return true;
  }

  async setAwake(awake: boolean) {
    if (this.awake === awake) return;
    this.awake = awake;
    this.peeking = false;
    const token = ++this.moveId;
    if (awake) {
      if (await this.travel(this.awakeCenter(), token)) this.facing = 1;
    } else {
      this.lookTarget = { x: 0, y: 0 };
      if (!(await this.travel(this.dockCenter("peek"), token))) return;
      this.facing = this.side === "right" ? -1 : 1;
      const o = this.dockCenter("peek");
      const h = this.dockCenter("hidden");
      await this.tween(260, (u) => this.place({ x: o.x + (h.x - o.x) * (Math.floor(u * 4) / 4), y: o.y }), token);
    }
    this.requestFrame();
  }

  /** 偶尔冒头：4 帧「顿挫」探出 → 左右看 → 眨眼 → 缩回去。被叫醒时立刻中止。 */
  async peek() {
    if (this.awake || this.moving || this.peeking || this.reduced || this.destroyed) return;
    this.peeking = true;
    const token = ++this.moveId;
    this.facing = this.side === "right" ? -1 : 1;
    const out = this.dockCenter("peek");
    const home = this.dockCenter("hidden");
    const dir = this.side === "right" ? -1 : 1;
    const alive = () => this.peeking && token === this.moveId;
    this.requestFrame();
    if (!(await this.tween(260, (u) => this.place({ x: home.x + (out.x - home.x) * (Math.floor(u * 4) / 4), y: home.y }), token))) return;
    this.lookTarget = { x: -dir, y: 0 };
    await sleep(520);
    if (!alive()) return;
    this.lookTarget = { x: 0, y: -1 };
    await sleep(480);
    if (!alive()) return;
    this.blink = 0.14;
    await sleep(700);
    if (!alive()) return;
    if (!(await this.tween(260, (u) => this.place({ x: out.x + (home.x - out.x) * (Math.floor(u * 4) / 4), y: home.y }), token))) return;
    this.lookTarget = { x: 0, y: 0 };
    this.peeking = false;
    this.requestFrame();
  }

  get isDockedIdle() {
    return !this.awake && !this.moving && !this.peeking;
  }

  /** 从角色头部射出一串像素飞向目标元素，到达后迸裂并触发回调（用来高亮目标）。 */
  beam(target: Element | null, onArrive?: () => void) {
    if (!target || this.reduced) {
      onArrive?.();
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      onArrive?.();
      return;
    }
    const to = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const from = { x: this.pos.x, y: this.pos.y - 3 * BUDDY_UNIT };
    const arc = Math.max(60, Math.min(220, Math.abs(to.y - from.y) * 0.35 + 70));
    const count = 14;
    for (let index = 0; index < count; index += 1) {
      this.beams.push({ from, to, t: 0, dur: 0.62 + index * 0.012, delay: index * 0.028, arc, arrived: false, onArrive: index === count - 1 ? onArrive : undefined });
    }
    this.requestFrame();
  }

  private puff(x: number, y: number, count: number) {
    for (let index = 0; index < count; index += 1) {
      this.dust.push({ x: x + (Math.random() - 0.5) * 26, y, vx: (Math.random() - 0.5) * 90, vy: -30 - Math.random() * 40, life: 0.45 + Math.random() * 0.2, age: 0 });
    }
  }

  // ───────────── 绘制 ─────────────
  private rect(gx: number, gy: number, gw: number, gh: number, color: string) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(gx * BUDDY_UNIT), Math.round(gy * BUDDY_UNIT), gw * BUDDY_UNIT, gh * BUDDY_UNIT);
  }

  private drawSprite(time: number) {
    const ctx = this.ctx;
    const pal = this.palette;
    const phase = this.phase;
    const since = time - this.phaseSince;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, BUDDY_BOX, BUDDY_BOX);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    if (this.facing === -1) {
      ctx.translate(BUDDY_BOX, 0);
      ctx.scale(-1, 1);
    }
    let bx = Math.round((CENTER - 6 * BUDDY_UNIT) / BUDDY_UNIT);
    let by = Math.round((CENTER - 5.5 * BUDDY_UNIT) / BUDDY_UNIT);
    if (phase === "refuse") bx += Math.round(Math.sin(since * 34) * 1.2 * Math.max(0, 1 - since / 0.7));
    if (phase === "nod") by += Math.round(Math.sin(Math.min(1, since / 0.5) * Math.PI * 2) * -1 * Math.max(0, 1 - since / 0.8));
    if (phase === "happy") by -= Math.round(Math.abs(Math.sin(Math.min(1, since / 0.45) * Math.PI)) * 2);
    const squash = this.squash > 0;
    const rows = BODY_ROWS.filter((_, index) => !(squash && index === 4));
    const height = rows.length;
    const y0 = by + 1;
    // 地面阴影
    if (this.awake) {
      const width = this.airborne ? 6 : 10;
      ctx.globalAlpha = 0.28;
      this.rect(bx + 6 - width / 2, y0 + height + 3, width, 1, "#000");
      ctx.globalAlpha = 1;
    }
    // 触角：工作时快闪，思考时慢闪
    const tipOn = phase === "working" ? Math.floor(time * 8) % 2 === 0 : phase === "thinking" || phase === "talking" ? Math.floor(time * 5) % 2 === 0 : true;
    const tipColor = phase === "refuse" ? ACCENT.amber : phase === "happy" ? ACCENT.green : tipOn ? pal.tip : pal.soft;
    this.rect(bx + 5, by - 1, 2, 2, pal.shade);
    this.rect(bx + 5, by - 2, 2, 1, tipColor);
    // 身体：高光顶行 / 底部暗部 / 右侧体积
    rows.forEach((row, r) => {
      for (let c = 0; c < 12; c += 1) {
        if (row[c] !== "X") continue;
        let color = pal.base;
        if (r === 0 || (r === 1 && c < 3)) color = pal.light;
        else if (r >= height - 2 || c === 11) color = pal.shade;
        this.rect(bx + c, y0 + r, 1, 1, color);
      }
    });
    // 脚：行走帧
    const step = this.airborne ? 2 : Math.floor(time * (phase === "working" ? 6 : 2)) % 2;
    const legs = this.airborne ? [3, 8] : step ? [2, 9] : [3, 8];
    legs.forEach((lx) => this.rect(bx + lx, y0 + height, 2, this.airborne ? 1 : 2, pal.shade));
    // 眼睛
    const ey = y0 + 3;
    const lx = this.look.x;
    const ly = this.look.y;
    const blinking = this.blink > 0;
    const eyes = (xs: number[], y: number, w: number, h: number) => xs.forEach((x) => this.rect(bx + x, y, w, h, pal.eye));
    if (phase === "happy") {
      [2, 7].forEach((x) => {
        this.rect(bx + x + 1, ey, 1, 1, pal.eye);
        this.rect(bx + x, ey + 1, 1, 1, pal.eye);
        this.rect(bx + x + 2, ey + 1, 1, 1, pal.eye);
      });
    } else if (phase === "refuse") {
      [2, 7].forEach((x) => this.rect(bx + x, ey + 1, 3, 1, pal.eye));
    } else if (phase === "listening") {
      eyes([2 + lx, 8 + lx], ey + ly - (blinking ? -1 : 1), 2, blinking ? 1 : 4);
    } else if (phase === "thinking") {
      const sx = [-1, 0, 1, 0][Math.floor(time * 2.5) % 4];
      eyes([2 + sx, 8 + sx], ey, 2, blinking ? 1 : 3);
    } else if (phase === "confirming") {
      // 盯着对话框：眼睛上抬一格
      eyes([2, 8], ey - 1, 2, blinking ? 1 : 3);
    } else if (phase === "sleeping" && !this.awake) {
      eyes([2 + lx, 8 + lx], ey + 1 + ly, 2, blinking ? 1 : 3);
    } else {
      eyes([2 + lx, 8 + lx], ey + ly + (blinking ? 1 : 0), 2, blinking ? 1 : 3);
    }
    // 嘴：听写和回答时随音量 / 节奏张合
    if (phase === "listening") {
      const mh = 1 + Math.round(this.level * 2);
      this.rect(bx + 5, y0 + 7 - (mh > 1 ? 1 : 0), 2, mh, pal.eye);
    } else if (phase === "talking") {
      const open = Math.floor(time * 7) % 3;
      this.rect(bx + 5, y0 + 7 - (open === 2 ? 1 : 0), 2, open === 0 ? 1 : open + 0, pal.eye);
    }
    // 思考：头顶三个像素点依次亮起
    if (phase === "thinking") {
      const k = Math.floor(time * 3) % 4;
      [0, 1, 2].forEach((i) => {
        if (i < k) this.rect(bx + 3 + i * 2, by - 5, 1, 1, pal.tip);
      });
    }
    // 听写：两侧像素声波，按音量一格一格长高
    if (phase === "listening") {
      [[-3, -1], [-5, -1.6], [15, 1], [17, 1.6]].forEach(([dx, k], i) => {
        const n = 1 + Math.round(this.level * (2 + Math.abs(k) * 1.6) * (0.65 + 0.35 * Math.sin(time * 9 + i * 2)));
        for (let j = 0; j < n; j += 1) this.rect(bx + dx, y0 + 3 - Math.floor(n / 2) + j + 1, 1, 1, i % 2 ? pal.soft : pal.light);
      });
    }
    // 脚下的进度条：执行时是步骤进度，停顿确认时是倒计时（从满到空）
    const barY = y0 + height + 5;
    if (phase === "working") {
      const lit = Math.round(this.progress * 10);
      for (let i = 0; i < 10; i += 1) this.rect(bx + 1 + i, barY, 1, 1, i < lit ? pal.light : "rgba(174,186,210,.2)");
    } else if (phase === "confirming" && this.countdown !== null) {
      const lit = Math.max(0, Math.ceil(this.countdown * 10));
      for (let i = 0; i < 10; i += 1) this.rect(bx + 1 + i, barY, 1, 1, i < lit ? ACCENT.amber : "rgba(174,186,210,.2)");
    }
    // 完成：两颗像素闪光
    if (phase === "happy" && since < 1.1) {
      const k = Math.floor(since * 8) % 2;
      const sparkle = (x: number, y: number) => {
        this.rect(bx + x, y0 + y, 1, 1, ACCENT.green);
        if (k) {
          this.rect(bx + x - 1, y0 + y, 1, 1, pal.tip);
          this.rect(bx + x + 1, y0 + y, 1, 1, pal.tip);
          this.rect(bx + x, y0 + y - 1, 1, 1, pal.tip);
          this.rect(bx + x, y0 + y + 1, 1, 1, pal.tip);
        }
      };
      sparkle(-3, 0);
      sparkle(14, 1);
    }
    ctx.restore();
  }

  private drawEffects(dt: number) {
    const t = this.tctx;
    t.clearRect(0, 0, this.trail.width, this.trail.height);
    for (let i = this.dust.length - 1; i >= 0; i -= 1) {
      const d = this.dust[i];
      d.age += dt;
      if (d.age > d.life) {
        this.dust.splice(i, 1);
        continue;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vy += 140 * dt;
      const k = 1 - d.age / d.life;
      const size = k > 0.55 ? 6 : k > 0.25 ? 4 : 2;
      t.globalAlpha = Math.min(1, k * 1.6);
      t.fillStyle = this.palette.light;
      t.fillRect(Math.round(d.x / 2) * 2, Math.round(d.y / 2) * 2, size, size);
    }
    for (let i = this.beams.length - 1; i >= 0; i -= 1) {
      const b = this.beams[i];
      if (b.delay > 0) {
        b.delay -= dt;
        continue;
      }
      b.t += dt;
      const u = Math.min(1, b.t / b.dur);
      const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const control = { x: (b.from.x + b.to.x) / 2, y: Math.min(b.from.y, b.to.y) - b.arc };
      const x = (1 - eased) * (1 - eased) * b.from.x + 2 * (1 - eased) * eased * control.x + eased * eased * b.to.x;
      const y = (1 - eased) * (1 - eased) * b.from.y + 2 * (1 - eased) * eased * control.y + eased * eased * b.to.y;
      t.globalAlpha = 1 - u * 0.4;
      t.fillStyle = u > 0.85 ? "#fff" : this.palette.light;
      t.fillRect(Math.round(x / 2) * 2, Math.round(y / 2) * 2, 6, 6);
      t.globalAlpha = 0.45;
      t.fillStyle = this.palette.base;
      t.fillRect(Math.round(x / 2) * 2 + 2, Math.round(y / 2) * 2 + 2, 2, 2);
      if (u >= 1) {
        if (!b.arrived) {
          b.arrived = true;
          for (let k = 0; k < 4; k += 1) this.dust.push({ x: b.to.x, y: b.to.y, vx: (Math.random() - 0.5) * 220, vy: (Math.random() - 0.5) * 220, life: 0.4, age: 0 });
          b.onArrive?.();
        }
        this.beams.splice(i, 1);
      }
    }
    t.globalAlpha = 1;
  }

  // ───────────── 循环 ─────────────
  private needsLoop() {
    return this.awake || this.moving || this.peeking || this.dust.length > 0 || this.beams.length > 0 || this.phase !== "sleeping" || this.squash > 0;
  }

  /** 状态变化时调用：确保至少再画一帧，并在需要动画时启动循环。 */
  private requestFrame() {
    if (this.destroyed || this.raf) return;
    this.raf = requestAnimationFrame((ts) => this.frame(ts));
  }

  private frame(ts: number) {
    this.raf = 0;
    if (this.destroyed) return;
    const time = ts / 1000;
    const dt = Math.min(0.05, this.lastTick ? time - this.lastTick : 0.016);
    this.lastTick = time;
    // 眨眼与计时
    if (this.blink > 0) this.blink -= dt;
    else if (this.awake && Math.random() < dt / 3.2) this.blink = 0.14;
    if (this.squash > 0) this.squash -= dt;
    // 视线按整数格
    this.look.x = Math.abs(this.lookTarget.x) < 0.34 ? 0 : Math.sign(this.lookTarget.x) * (this.facing === -1 ? -1 : 1);
    this.look.y = this.lookTarget.y < -0.5 ? -1 : 0;
    this.level += (this.levelTarget - this.level) * Math.min(1, dt * 18);
    this.progress += (this.progressTarget - this.progress) * Math.min(1, dt * 8);
    if (time - this.lastDraw >= (this.airborne ? 1 / 30 : 1 / 12) || !this.needsLoop()) {
      this.lastDraw = time;
      this.drawSprite(time);
    }
    this.drawEffects(dt);
    if (this.needsLoop()) this.raf = requestAnimationFrame((next) => this.frame(next));
    else this.lastTick = 0;
  }
}
