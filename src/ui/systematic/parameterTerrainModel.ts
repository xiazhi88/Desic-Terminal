// Pure model for the parameter terrain view: parameter axes, candidate
// normalisation, robustness/overfit derivation, Gaussian-kernel field,
// marching-squares contours, sensitivity curves, colour ramps and the replay
// schedule. Nothing here touches the DOM, so it can be unit-tested and shared.
//
// The interpolated field is a visual aid only. Every number that can drive a
// decision (rank, neighbours, overfit gap) comes from measured candidates.
import type {
  SystematicOptimizationCandidate,
  SystematicOptimizationCandidatesView,
} from "../../lib/systematic";

export type TerrainStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type TerrainParam = {
  key: string;
  kind: "int" | "float";
  decimals: number;
  min: number;
  max: number;
  step: number;
  base: number;
  n: number;
  values: number[];
  lo: number;
  hi: number;
};

export type TerrainMetrics = {
  netReturnPct: number;
  maxDrawdownPct: number;
  annualizedSharpe?: number | null;
  closedTradeCount: number;
  winRate?: number | null;
};

export type TerrainCandidate = {
  index: number;
  params: Record<string, number>;
  parameters: Record<string, unknown>;
  u: number[];
  status: TerrainStatus;
  trainCalmar: number | null;
  validationCalmar: number | null;
  validationCalmarReason: string | null;
  trainMetrics: TerrainMetrics | null;
  validationMetrics: TerrainMetrics | null;
  error: string | null;
  updatedAt: number;
  /** Replay schedule in seconds from the optimization start. */
  start: number | null;
  end: number | null;
};

export type RobustnessGrade = "robust" | "fair" | "fragile" | "none";

export type TerrainNeighbors = {
  list: { c: TerrainCandidate; d: number }[];
  widened: boolean;
  radius: number;
  med: number;
  worst: number;
  best: number;
  drop?: number;
  dropPct: number | null;
  grade: RobustnessGrade;
};

export type TerrainDerived = {
  st: TerrainStatus[];
  done: TerrainCandidate[];
  valid: TerrainCandidate[];
  gap: Map<number, number>;
  rank: Map<number, number>;
  neighbors: (c: TerrainCandidate) => TerrainNeighbors;
  best: TerrainCandidate | null;
  robust: TerrainCandidate | null;
  running: TerrainCandidate[];
  base: TerrainCandidate | null;
};

export const NB_R = 0.3;
export const NB_MIN = 4;
export const GMAX = 3;
export const GAP_HI = 1.5;
export const FIELD_NX = 150;
export const FIELD_NY = 104;
export const FIELD_H = 0.07;
const FIELD_HN = 0.03;
const FIELD_BETA = 4;

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stepDecimals(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 2;
  for (let d = 0; d <= 6; d += 1) {
    if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-7) return d;
  }
  return 6;
}

function isInt(v: number) {
  return Math.abs(v - Math.round(v)) < 1e-9;
}

function asMetrics(value: unknown): TerrainMetrics | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const netReturnPct = asFiniteNumber(record.netReturnPct);
  const maxDrawdownPct = asFiniteNumber(record.maxDrawdownPct);
  if (netReturnPct === null || maxDrawdownPct === null) return null;
  return {
    netReturnPct,
    maxDrawdownPct,
    annualizedSharpe: asFiniteNumber(record.annualizedSharpe),
    closedTradeCount: asFiniteNumber(record.closedTradeCount) ?? 0,
    winRate: asFiniteNumber(record.winRate),
  };
}

function normalizeStatus(status: string): TerrainStatus {
  if (status === "running" || status === "completed" || status === "failed" || status === "cancelled") return status;
  if (status === "cancelling") return "running";
  return "queued";
}

/**
 * Tuned axes: saved tuning ranges first; when the pinned version cannot be
 * read, any numeric parameter that varies across candidates, with its range
 * and step recovered from the candidate values.
 */
export function buildTerrainParams(view: SystematicOptimizationCandidatesView): TerrainParam[] {
  const candidates = view.candidates;
  const valuesOf = (key: string) => candidates
    .map((candidate) => asFiniteNumber((candidate.parameters as Record<string, unknown> | null)?.[key]))
    .filter((value): value is number => value !== null);
  let keys = Object.keys(view.parameterTuning ?? {}).filter((key) => valuesOf(key).length > 0);
  if (!keys.length) {
    const first = (candidates[0]?.parameters ?? {}) as Record<string, unknown>;
    keys = Object.keys(first).filter((key) => new Set(valuesOf(key)).size > 1);
  }
  return keys.map((key) => {
    const observed = valuesOf(key);
    const tuning = view.parameterTuning?.[key];
    let min = tuning?.min ?? Math.min(...observed);
    let max = tuning?.max ?? Math.max(...observed);
    let step = tuning?.step ?? 0;
    if (!(step > 0)) {
      const sorted = [...new Set(observed)].sort((a, b) => a - b);
      step = sorted.slice(1).reduce((acc, v, i) => Math.min(acc, v - sorted[i]), Number.POSITIVE_INFINITY);
      if (!Number.isFinite(step) || step <= 0) step = 1;
    }
    min = Math.min(min, ...observed);
    max = Math.max(max, ...observed);
    if (max <= min) max = min + step;
    const base = asFiniteNumber((view.baselineParameters as Record<string, unknown> | null)?.[key]) ?? observed[0] ?? min;
    const n = Math.max(1, Math.floor((max - min) / step + 1e-9) + 1);
    const decimals = stepDecimals(step);
    const values = Array.from({ length: n }, (_, i) => Number((min + step * i).toFixed(Math.max(decimals, 4))));
    const kind = isInt(min) && isInt(step) && observed.every(isInt) ? "int" : "float";
    return { key, kind, decimals: kind === "int" ? 0 : Math.max(decimals, 2), min, max, step, base, n, values, lo: min - step / 2, hi: max + step / 2 };
  });
}

export function buildTerrainCandidates(view: SystematicOptimizationCandidatesView, params: TerrainParam[]): TerrainCandidate[] {
  return view.candidates.map((candidate: SystematicOptimizationCandidate) => {
    const parameters = (candidate.parameters ?? {}) as Record<string, unknown>;
    const values: Record<string, number> = {};
    const u = params.map((p) => {
      const v = asFiniteNumber(parameters[p.key]) ?? p.base;
      values[p.key] = v;
      return p.max > p.min ? clamp((v - p.min) / (p.max - p.min), 0, 1) : 0.5;
    });
    const status = normalizeStatus(candidate.status);
    return {
      index: candidate.index,
      params: values,
      parameters,
      u,
      status,
      trainCalmar: status === "completed" ? asFiniteNumber(candidate.trainCalmar) : null,
      validationCalmar: status === "completed" ? asFiniteNumber(candidate.validationCalmar) : null,
      validationCalmarReason: candidate.validationCalmarReason ?? null,
      trainMetrics: asMetrics(candidate.trainMetrics),
      validationMetrics: asMetrics(candidate.validationMetrics),
      error: candidate.error ?? null,
      updatedAt: candidate.updatedAt,
      start: null,
      end: null,
    };
  });
}

/** Normalised position of a value on a parameter axis (half-step margins). */
export const nu = (p: TerrainParam, v: number) => (v - p.lo) / (p.hi - p.lo);

export function formatParam(p: TerrainParam, v: number) {
  return p.kind === "int" ? String(Math.round(v)) : v.toFixed(p.decimals);
}

export function median(a: number[]) {
  if (!a.length) return Number.NaN;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function robustZ(vals: number[]) {
  const m = median(vals);
  const mad = median(vals.map((v) => Math.abs(v - m))) * 1.4826 || 1;
  return (v: number) => (v - m) / mad;
}

function distance(a: number[], b: number[]) {
  let s = 0;
  for (let d = 0; d < a.length; d += 1) s += (a[d] - b[d]) ** 2;
  return Math.sqrt(s);
}

export function isTerminal(status: TerrainStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function deriveTerrain(cands: TerrainCandidate[], st: TerrainStatus[]): TerrainDerived {
  const done = cands.filter((_, i) => isTerminal(st[i]));
  const valid = cands.filter((c, i) => st[i] === "completed" && c.validationCalmar != null);
  const paired = valid.filter((c) => c.trainCalmar != null);
  const zT = paired.length > 3 ? robustZ(paired.map((c) => c.trainCalmar as number)) : () => 0;
  const zV = paired.length > 3 ? robustZ(paired.map((c) => c.validationCalmar as number)) : () => 0;
  const gap = new Map<number, number>();
  paired.forEach((c) => gap.set(c.index, zT(c.trainCalmar as number) - zV(c.validationCalmar as number)));
  const ranked = [...valid].sort((a, b) => (b.validationCalmar as number) - (a.validationCalmar as number) || a.index - b.index);
  const rank = new Map(ranked.map((c, i) => [c.index, i + 1]));
  const cache = new Map<number, TerrainNeighbors>();
  const neighbors = (c: TerrainCandidate): TerrainNeighbors => {
    const cached = cache.get(c.index);
    if (cached) return cached;
    const ds = valid.filter((o) => o !== c).map((o) => ({ c: o, d: distance(o.u, c.u) })).sort((a, b) => a.d - b.d);
    let list = ds.filter((o) => o.d <= NB_R);
    let widened = false;
    if (list.length < NB_MIN) { list = ds.slice(0, NB_MIN); widened = true; }
    const vals = list.map((o) => o.c.validationCalmar as number);
    const res: TerrainNeighbors = {
      list,
      widened,
      radius: list.length ? list[list.length - 1].d : 0,
      med: median(vals),
      worst: vals.length ? Math.min(...vals) : Number.NaN,
      best: vals.length ? Math.max(...vals) : Number.NaN,
      dropPct: null,
      grade: "none",
    };
    if (c.validationCalmar != null && vals.length) {
      res.drop = c.validationCalmar - res.med;
      res.dropPct = c.validationCalmar > 0 ? res.drop / c.validationCalmar : null;
      res.grade = res.dropPct == null ? "none" : res.dropPct < 0.2 ? "robust" : res.dropPct < 0.45 ? "fair" : "fragile";
    }
    cache.set(c.index, res);
    return res;
  };
  // Robust pick: the candidate whose worse of (itself, neighbourhood median) is highest.
  let robust: TerrainCandidate | null = null;
  let robustScore = Number.NEGATIVE_INFINITY;
  valid.forEach((c) => {
    const nb = neighbors(c);
    if (!nb.list.length) return;
    const score = Math.min(c.validationCalmar as number, nb.med);
    if (score > robustScore) { robustScore = score; robust = c; }
  });
  const running = cands.filter((_, i) => st[i] === "running");
  return { st, done, valid, gap, rank, neighbors, best: ranked[0] ?? null, robust, running, base: cands.find((c) => c.index === 0) ?? null };
}

/** Fixed colour domain (half-unit aligned) so the ramp does not jump. */
export function valueDomain(cands: TerrainCandidate[]): [number, number] {
  const all = cands.filter((c) => c.status === "completed" && c.validationCalmar != null).map((c) => c.validationCalmar as number);
  if (!all.length) return [-1, 1];
  let lo = Math.floor(Math.min(...all) * 2) / 2;
  let hi = Math.ceil(Math.max(...all) * 2) / 2;
  if (hi - lo < 0.5) { lo -= 0.5; hi += 0.5; }
  return [lo, hi];
}

/** Contour interval: 0.5 unless the domain is wide. */
export function contourInterval(vmin: number, vmax: number) {
  const span = vmax - vmin;
  return span <= 5 ? 0.5 : span <= 10 ? 1 : Math.ceil(span / 10);
}

export function contourLevels(vmin: number, vmax: number) {
  const step = contourInterval(vmin, vmax);
  const out: number[] = [];
  for (let v = Math.ceil(vmin / step) * step; v < vmax - 1e-9; v += step) {
    if (v > vmin + 1e-9) out.push(Number(v.toFixed(6)));
  }
  return out;
}

export type TerrainField = {
  val: Float32Array;
  gap: Float32Array;
  alpha: Float32Array;
  nx: number;
  ny: number;
};

type FieldPoint = { x: number; y: number; v: number; g: number; mv: number; mg: number };

function weightedMedian(buf: [number, number, number][], idx: 1 | 2) {
  if (!buf.length) return Number.NaN;
  buf.sort((a, b) => a[idx] - b[idx]);
  let total = 0;
  for (const b of buf) total += b[0];
  let acc = 0;
  for (const b of buf) { acc += b[0]; if (acc >= total / 2) return b[idx]; }
  return buf[buf.length - 1][idx];
}

/**
 * Gaussian-kernel field over the X × Y projection. "best" soft-maximises the
 * hidden dimensions inside each projected location before smoothing; "median"
 * takes a kernel-weighted median. Alpha fades where no measured point is near.
 */
export function computeTerrainField(
  derived: TerrainDerived,
  px: TerrainParam,
  py: TerrainParam,
  marg: "best" | "median",
  nx = FIELD_NX,
  ny = FIELD_NY,
): TerrainField {
  const pts: FieldPoint[] = derived.valid.map((c) => ({
    x: nu(px, c.params[px.key]),
    y: nu(py, c.params[py.key]),
    v: c.validationCalmar as number,
    g: derived.gap.get(c.index) ?? 0,
    mv: 0,
    mg: 0,
  }));
  const val = new Float32Array(nx * ny);
  const gap = new Float32Array(nx * ny);
  const alpha = new Float32Array(nx * ny);
  if (marg === "best") {
    pts.forEach((p) => {
      let sw = 0, sv = 0, sg = 0;
      let top = -9;
      for (const q of pts) if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 < 0.0036 && q.v > top) top = q.v;
      pts.forEach((q) => {
        const d2 = ((q.x - p.x) ** 2 + (q.y - p.y) ** 2) / (2 * FIELD_HN * FIELD_HN);
        if (d2 > 9) return;
        const w = Math.exp(-d2) * Math.exp(FIELD_BETA * (q.v - top));
        sw += w; sv += w * q.v; sg += w * q.g;
      });
      p.mv = sw > 0 ? sv / sw : p.v;
      p.mg = sw > 0 ? sg / sw : p.g;
    });
  }
  const buf: [number, number, number][] = [];
  for (let j = 0; j < ny; j += 1) {
    const uy = (j + 0.5) / ny;
    for (let i = 0; i < nx; i += 1) {
      const ux = (i + 0.5) / nx;
      let sw = 0, sv = 0, sg = 0;
      buf.length = 0;
      for (const p of pts) {
        const d2 = ((ux - p.x) ** 2 + (uy - p.y) ** 2) / (2 * FIELD_H * FIELD_H);
        if (d2 > 9) continue;
        const w = Math.exp(-d2);
        sw += w;
        if (marg === "best") { sv += w * p.mv; sg += w * p.mg; } else buf.push([w, p.v, p.g]);
      }
      const k = j * nx + i;
      alpha[k] = 1 - Math.exp(-sw / 0.55);
      if (sw < 1e-4) { val[k] = Number.NaN; gap[k] = Number.NaN; continue; }
      if (marg === "best") { val[k] = sv / sw; gap[k] = sg / sw; } else { val[k] = weightedMedian(buf, 1); gap[k] = weightedMedian(buf, 2); }
    }
  }
  return { val, gap, alpha, nx, ny };
}

export type ContourSegment = [[number, number], [number, number]];

/** Marching squares; segments are in field grid units. */
export function contourSegments(arr: Float32Array, alpha: Float32Array, nx: number, ny: number, levels: number[]) {
  const out: { level: number; segs: ContourSegment[] }[] = [];
  for (const L of levels) {
    const segs: ContourSegment[] = [];
    for (let j = 0; j < ny - 1; j += 1) for (let i = 0; i < nx - 1; i += 1) {
      const k = j * nx + i;
      if (alpha[k] < 0.3 || alpha[k + 1] < 0.3 || alpha[k + nx] < 0.3 || alpha[k + nx + 1] < 0.3) continue;
      const a = arr[k], b = arr[k + 1], c = arr[k + nx + 1], d = arr[k + nx];
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) continue;
      const pts: [number, number][] = [];
      const e = (v0: number, v1: number, x0: number, y0: number, x1: number, y1: number) => {
        if ((v0 < L) !== (v1 < L)) { const f = (L - v0) / (v1 - v0); pts.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]); }
      };
      e(a, b, i, j, i + 1, j); e(b, c, i + 1, j, i + 1, j + 1); e(d, c, i, j + 1, i + 1, j + 1); e(a, d, i, j, i, j + 1);
      if (pts.length >= 2) segs.push([pts[0], pts[1]]);
      if (pts.length === 4) segs.push([pts[2], pts[3]]);
    }
    out.push({ level: L, segs });
  }
  return out;
}

/** Field value at a normalised plot position (for the hover readout). */
export function sampleField(field: TerrainField, ux: number, uy: number) {
  const i = clamp(Math.floor(ux * field.nx), 0, field.nx - 1);
  const j = clamp(Math.floor(uy * field.ny), 0, field.ny - 1);
  const k = j * field.nx + i;
  return { alpha: field.alpha[k], val: field.val[k], gap: field.gap[k] };
}

/**
 * Conditional sensitivity for one parameter: other dimensions are weighted by
 * their distance to the selected candidate. Returns null where support is thin.
 */
export function sensitivityModel(derived: TerrainDerived, params: TerrainParam[], d: number, sel: TerrainCandidate) {
  const p = params[d];
  const pts = derived.valid.map((o) => {
    let s = 0;
    params.forEach((_, k) => { if (k !== d) s += (o.u[k] - sel.u[k]) ** 2; });
    return { o, wo: Math.exp(-s / (2 * 0.22 * 0.22)) };
  });
  const maxW = Math.max(1e-6, ...pts.map((q) => q.wo));
  const curve = (v: number) => {
    const ux = nu(p, v);
    let sw = 0, sv = 0;
    pts.forEach(({ o, wo }) => {
      const wx = Math.exp(-((ux - nu(p, o.params[p.key])) ** 2) / (2 * 0.07 * 0.07));
      const ww = wo * wx;
      sw += ww; sv += ww * (o.validationCalmar as number);
    });
    return sw > 0.05 * maxW ? sv / sw : null;
  };
  const sv = sel.params[p.key];
  const y0 = curve(sv);
  let worst1: number | null = null;
  let worst2: number | null = null;
  if (y0 != null) {
    const ds = [sv - p.step, sv + p.step].filter((v) => v >= p.min - 1e-9 && v <= p.max + 1e-9).map(curve).filter((v): v is number => v != null).map((v) => v - y0);
    worst1 = ds.length ? Math.min(...ds) : 0;
    const ds2 = [sv - 2 * p.step, sv + 2 * p.step].filter((v) => v >= p.min - 1e-9 && v <= p.max + 1e-9).map(curve).filter((v): v is number => v != null).map((v) => v - y0);
    worst2 = ds2.length ? Math.min(...ds2) : 0;
  }
  return { pts, maxW, curve, y0, worst1, worst2 };
}

// ── Replay schedule ──────────────────────────────────────────────
/**
 * Reconstructs when each candidate ran: `workers` lanes claim candidates in
 * index order (the backend's fetch_add), each finishing at its persisted
 * `updatedAt`. Returns the total span in seconds.
 */
export function scheduleReplay(cands: TerrainCandidate[], startedAt: number | null | undefined, workers: number | null | undefined) {
  const terminal = cands.filter((c) => isTerminal(c.status) && Number.isFinite(c.updatedAt));
  const origin = startedAt ?? (terminal.length ? Math.min(...terminal.map((c) => c.updatedAt)) : 0);
  const lanes = new Array(Math.max(1, workers ?? 1)).fill(0);
  let tEnd = 0;
  [...cands].sort((a, b) => a.index - b.index).forEach((c) => {
    // Cancelled rows may never have been claimed; they appear only at the end.
    if (c.status !== "completed" && c.status !== "failed") {
      c.start = null; c.end = null; return;
    }
    let w = 0;
    for (let k = 1; k < lanes.length; k += 1) if (lanes[k] < lanes[w]) w = k;
    const start = lanes[w];
    const end = Math.max(start + 0.05, (c.updatedAt - origin) / 1000);
    c.start = start + 0.02;
    c.end = end;
    lanes[w] = end;
    tEnd = Math.max(tEnd, end);
  });
  return Math.max(tEnd, 0.1);
}

export function statusAt(c: TerrainCandidate, t: number, tEnd: number): TerrainStatus {
  if (c.end == null || c.start == null) return t >= tEnd ? c.status : "queued";
  if (t >= c.end) return c.status;
  if (t >= c.start) return "running";
  return "queued";
}

// ── Colour ramps ─────────────────────────────────────────────────
function oklchToRgb(L: number, C: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180, a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin.map((x) => {
    const v = clamp(x, 0, 1);
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  }) as [number, number, number];
}

function makeLut(stops: [number, number, number, number][]) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k += 1;
    const [t0, L0, C0, h0] = stops[k], [t1, L1, C1, h1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    lut.set(oklchToRgb(L0 + (L1 - L0) * f, C0 + (C1 - C0) * f, h0 + (h1 - h0) * f), i * 3);
  }
  return lut;
}

/** Validation Calmar: dark → signal blue → near white (monotonic lightness, never red/green). */
export const LUT_CALMAR = makeLut([[0, 0.2, 0.03, 262], [0.38, 0.43, 0.09, 252], [0.72, 0.74, 0.11, 243], [1, 0.97, 0.025, 225]]);
/** Overfit gap: neutral → amber (the only place warn colour is used). */
export const LUT_GAP = makeLut([[0, 0.36, 0.004, 70], [0.45, 0.55, 0.08, 70], [1, 0.86, 0.155, 80]]);
export const WARN_RGB = "rgb(243,178,60)";

export const lutCss = (lut: Uint8ClampedArray, t: number, a = 1) => {
  const i = Math.round(clamp(t, 0, 1) * 255) * 3;
  return `rgba(${lut[i]},${lut[i + 1]},${lut[i + 2]},${a})`;
};
export const gradientCss = (lut: Uint8ClampedArray) => `linear-gradient(90deg,${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => lutCss(lut, t)).join(",")})`;
export const gapT = (g: number) => clamp(g / GMAX, 0, 1);

/** Rasterises the field into RGBA (y flipped) plus the overfit hatch mask. */
export function rasterizeField(field: TerrainField, colorBy: "calmar" | "gap", vmin: number, vmax: number) {
  const { nx, ny, val, gap, alpha } = field;
  const img = new Uint8ClampedArray(nx * ny * 4);
  const mask = new Uint8ClampedArray(nx * ny * 4);
  const lut = colorBy === "gap" ? LUT_GAP : LUT_CALMAR;
  for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) {
    const k = j * nx + i, o = ((ny - 1 - j) * nx + i) * 4;
    const a = alpha[k];
    if (!(a > 0.004) || Number.isNaN(val[k])) continue;
    const t = colorBy === "gap" ? gapT(gap[k]) : clamp((val[k] - vmin) / (vmax - vmin), 0, 1);
    const li = Math.round(t * 255) * 3;
    img[o] = lut[li]; img[o + 1] = lut[li + 1]; img[o + 2] = lut[li + 2];
    img[o + 3] = Math.round(255 * a ** 0.9 * 0.66);
    const h = clamp((gap[k] - (GAP_HI - 0.3)) / 0.6, 0, 1) * clamp((a - 0.2) / 0.3, 0, 1);
    mask[o + 3] = Math.round(255 * (Number.isNaN(h) ? 0 : h));
  }
  return { img, mask };
}
