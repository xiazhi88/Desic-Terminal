// Deterministic parameter-terrain fixtures for browser previews and smoke tests.
// The shape matches the `systematic_optimization_candidates` command. Metrics come
// from a synthetic objective (broad plateau + a train-overfit region + one narrow
// validation spike), ported from viz/prototypes/parameter-terrain.html. Synthetic
// values only; nothing here resembles real account data.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const TERRAIN_FIXTURE_TUNING = {
  fastPeriod: { min: 5, max: 30, step: 1 },
  slowPeriod: { min: 20, max: 90, step: 5 },
  riskPct: { min: 0.2, max: 2, step: 0.1 },
};
const BASELINE = { fastPeriod: 10, slowPeriod: 30, riskPct: 0.8 };

/**
 * @param {{ id: string, strategyId: string, instId: string, createdAt: number,
 *   budget?: number, workers?: number, runningAt?: number | null, seed?: number }} options
 *   `runningAt` (0..1) freezes the run part-way to exercise queued/running rows.
 */
export function terrainFixture({ id, strategyId, instId, createdAt, budget = 100, workers = 4, runningAt = null, seed = 20260928 }) {
  const keys = Object.keys(TERRAIN_FIXTURE_TUNING);
  const dims = keys.map((key) => {
    const { min, max, step } = TERRAIN_FIXTURE_TUNING[key];
    const n = Math.round((max - min) / step) + 1;
    const values = Array.from({ length: n }, (_, i) => Number((min + step * i).toFixed(4)));
    return { key, n, values, baseIdx: values.findIndex((v) => Math.abs(v - BASELINE[key]) < 1e-9) };
  });
  const R = rng(seed);
  const idxs = [dims.map((d) => d.baseIdx)];
  const seen = new Set([idxs[0].join(",")]);
  while (idxs.length < budget) {
    const it = dims.map((d) => Math.floor(R() * d.n));
    const k = it.join(",");
    if (!seen.has(k)) { seen.add(k); idxs.push(it); }
  }
  const U = idxs.map((it) => it.map((i, d) => i / (dims[d].n - 1)));
  let spikeI = 1, sd = 1e9;
  for (let i = 1; i < budget; i += 1) {
    const u = U[i];
    const d = (u[0] - 0.12) ** 2 + (u[1] - 0.16) ** 2 + 0.3 * (u[2] - 0.3) ** 2;
    if (d < sd) { sd = d; spikeI = i; }
  }
  const SC = U[spikeI];
  const failedIndex = Math.min(budget - 1, 71);
  const trainDays = 63, valDays = 27;
  const rows = idxs.map((it, i) => {
    const u = U[i];
    const r = rng(4000 + i * 7);
    const g1 = gauss(r), g2 = gauss(r), g3 = gauss(r);
    const q = (u[0] - 0.58) ** 2 / 0.2 + (u[1] - 0.62) ** 2 / 0.22 + (u[2] - 0.5) ** 2 / 0.7;
    const P = Math.exp(-Math.max(0, q - 0.45));
    const O = Math.exp(-((u[0] - SC[0]) ** 2 / 0.022 + (u[1] - SC[1]) ** 2 / 0.026));
    let s2 = 0;
    for (let d = 0; d < dims.length; d += 1) s2 += (u[d] - SC[d]) ** 2;
    const S = Math.exp(-s2 / 0.006);
    const trainCal = 0.2 + 2.6 * P + 3.2 * O + 3.6 * S + g1 * 0.16;
    const valCal = -0.75 + 2.3 * P + 0.1 * O + 2.4 * S + g2 * 0.1;
    const valTrades = Math.max(3, Math.round((7 + 62 * Math.pow(1 - u[1], 1.1) * (1 - 0.4 * u[2]) + 8 * (1 - u[0])) * (0.88 + 0.24 * r())));
    const trainTrades = Math.round(valTrades * trainDays / valDays * (0.9 + 0.2 * r()));
    const ddV = 2.0 + 3.2 * (1 - P) + 0.7 * Math.abs(g3) + 0.5 * O;
    const ddT = Math.max(1.6, 3.0 + 4.0 * (1 - P) - 1.0 * O - 0.8 * S + 0.8 * Math.abs(g3));
    const parameters = {};
    dims.forEach((d, k) => { parameters[d.key] = d.values[it[k]]; });
    const metrics = (cal, dd, trades, win, sharpe) => ({
      netReturnPct: Number((cal * dd).toFixed(2)),
      maxDrawdownPct: Number(dd.toFixed(2)),
      annualizedSharpe: Number(sharpe.toFixed(2)),
      closedTradeCount: trades,
      winRate: Number(clamp(win, 0.18, 0.78).toFixed(3)),
      feesUsdt: Number((trades * (3.6 + r() * 1.4)).toFixed(2)),
      fundingCashflowUsdt: Number(((r() - 0.55) * 18).toFixed(2)),
    });
    const duration = 6.2 + trainTrades * 0.018 + r() * 3.2;
    if (i === failedIndex) {
      return { index: i, parameters, status: "failed", trainMetrics: null, validationMetrics: null, trainCalmar: null, validationCalmar: null, validationCalmarReason: null, error: "Strategy callback timed out: on_bar exceeded 30 seconds", duration };
    }
    const trainMetrics = metrics(trainCal, ddT, trainTrades, 0.38 + 0.13 * P + 0.14 * O + 0.1 * S + g1 * 0.02, trainCal * 1.05 + g3 * 0.15);
    const validationMetrics = metrics(valCal, ddV, valTrades, 0.36 + 0.15 * P + 0.04 * S + g2 * 0.025, valCal * 1.2 + g3 * 0.2);
    const scored = valTrades >= 10;
    return {
      index: i,
      parameters,
      status: "completed",
      trainMetrics,
      validationMetrics,
      trainCalmar: Number((trainMetrics.netReturnPct / trainMetrics.maxDrawdownPct).toFixed(3)),
      validationCalmar: scored ? Number((validationMetrics.netReturnPct / validationMetrics.maxDrawdownPct).toFixed(3)) : null,
      validationCalmarReason: scored ? null : "insufficientTrades",
      error: null,
      duration,
    };
  });
  // Lanes claim in index order, as the backend's fetch_add does.
  const free = new Array(workers).fill(0);
  rows.forEach((row) => {
    let w = 0;
    for (let k = 1; k < workers; k += 1) if (free[k] < free[w]) w = k;
    row.start = free[w] + 0.4;
    row.end = row.start + row.duration;
    free[w] = row.end;
  });
  const span = Math.max(...rows.map((row) => row.end));
  const startedAt = createdAt + 1_500;
  const cutoff = runningAt == null ? Number.POSITIVE_INFINITY : span * runningAt;
  const candidates = rows.map(({ duration: _duration, start, end, ...row }) => {
    if (end <= cutoff) return { ...row, updatedAt: Math.round(startedAt + end * 1000) };
    const status = start <= cutoff ? "running" : "queued";
    return { ...row, status, trainMetrics: null, validationMetrics: null, trainCalmar: null, validationCalmar: null, validationCalmarReason: null, error: null, updatedAt: Math.round(startedAt + (status === "running" ? start : 0) * 1000) };
  });
  const completed = candidates.filter((c) => c.status === "completed" || c.status === "failed");
  const scored = candidates.filter((c) => c.status === "completed" && c.validationCalmar != null);
  const best = [...scored].sort((a, b) => b.validationCalmar - a.validationCalmar || a.index - b.index)[0] ?? null;
  const day = 86_400_000;
  const validationEndAt = createdAt - 3_600_000;
  const validationStartAt = validationEndAt - valDays * day;
  const active = runningAt != null;
  const elapsedMs = Math.round((active ? cutoff : span) * 1000);
  const optimization = {
    id,
    strategyId,
    instId,
    status: active ? "running" : "completed",
    candidateCount: budget,
    completedCount: completed.length,
    strategyVersion: 3,
    candidateBudget: budget,
    samplingMode: "sampled",
    workerCount: workers,
    trainEndAt: validationStartAt - 60_000,
    validationStartAt,
    validationEndAt,
    bestParameters: active || !best ? null : best.parameters,
    bestValidationCalmar: active || !best ? null : best.validationCalmar,
    baselineValidationCalmar: candidates[0].status === "completed" ? candidates[0].validationCalmar : null,
    startedAt,
    elapsedMs,
    estimatedRemainingMs: active && completed.length ? Math.round(elapsedMs * (budget - completed.length) / completed.length) : null,
    createdAt,
    finishedAt: active ? null : Math.round(startedAt + span * 1000),
    error: null,
  };
  return {
    optimization,
    parameterTuning: TERRAIN_FIXTURE_TUNING,
    baselineParameters: candidates[0].parameters,
    candidates,
  };
}
