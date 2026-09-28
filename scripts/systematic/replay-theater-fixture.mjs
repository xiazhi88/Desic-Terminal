// Deterministic backtest fixture for the replay theater preview/smoke.
// The generator is ported from viz/prototypes/replay-theater.html (buildRun) and runs on
// 1-minute bars like the desktop engine. `detailPage` mirrors the Rust
// `systematic_backtest_detail` projection: bars and strategy actions only for the
// requested page, sparse replay snapshots plus one carry-in row, the fill / closed-trade
// prefix up to the page end, and an equity curve with exact active points plus
// min/max-bucketed context.

const MINUTE = 60_000;
const DEFAULT_REPLAY_BAR_LIMIT = 1_500;
const MAX_REPLAY_BAR_LIMIT = 5_000;
const MAX_REPLAY_EQUITY_POINT_LIMIT = MAX_REPLAY_BAR_LIMIT + 2_400;

function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildReplayTheaterRun({ seed = 299, evaluationBars = 1824, preloadBars = 192, strategyName = "Multi-timeframe pullback", strategyId = "strategy-fixture" } = {}) {
  const r = rng(seed);
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const STEP = MINUTE;
  const PRE = preloadBars;
  const EVAL = evaluationBars;
  const N = PRE + EVAL;
  const T0 = Date.UTC(2026, 7, 29, 0, 0) - 8 * 3600e3;
  const REQ = {
    instId: "BTC-USDT-SWAP",
    initialEquityUsdt: 10000,
    preloadBars: PRE,
    leverage: 5,
    marginSafetyMultiplier: 1,
    execution: { entrySlippageBps: 2, exitSlippageBps: 2, entryFeeRate: 0.0005, exitFeeRate: 0.0005 },
    positionSizing: { mode: "equityPercent", perEntryBudget: 20, sameSideTotalBudget: 20 },
    endOfRunPolicy: "closeAtLastClose",
  };
  const CT_VAL = 0.01;
  // [end (fraction of the evaluation window × 19.1), drift/bar, vol/bar, mean reversion]
  const REG = [
    [0, 0.00002, 0.0021, 0.02], [2.4, 0.00004, 0.0019, 0.02], [6.2, 0.00026, 0.0019, 0.0],
    [10.3, 0.0, 0.0024, 0.05], [12.4, -0.0005, 0.003, 0.0], [15.1, 0.00002, 0.0015, 0.04],
    [17.6, 0.0002, 0.0019, 0.0], [19.1, -0.00016, 0.0025, 0.0],
  ];
  const regimeAt = (i) => {
    const d = ((i - PRE) / EVAL) * 19;
    for (const g of REG) if (d < g[0]) return g;
    return REG[REG.length - 1];
  };
  const bars = [];
  let px = 61850;
  let anchor = px;
  for (let i = 0; i < N; i++) {
    const [, drift, vol, mr] = regimeAt(i);
    if (i === 0 || regimeAt(i - 1) !== regimeAt(i)) anchor = px;
    const open = px;
    let p = open, hi = open, lo = open;
    for (let k = 0; k < 5; k++) {
      const pull = mr ? -mr * Math.log(p / anchor) / 5 : 0;
      const shock = gauss() * vol / Math.sqrt(5) * (1 + (r() < 0.015 ? 2.2 : 0));
      p = p * Math.exp(drift / 5 + pull + shock);
      hi = Math.max(hi, p); lo = Math.min(lo, p);
    }
    hi *= 1 + Math.abs(gauss()) * vol * 0.18;
    lo *= 1 - Math.abs(gauss()) * vol * 0.18;
    const close = p;
    const volume = Math.round(Math.exp(5.4 + Math.abs(gauss()) * 0.5) * 10) / 10;
    const openTimeMs = T0 + i * STEP;
    bars.push({ openTimeMs, closeTimeMs: openTimeMs + STEP, open, high: hi, low: lo, close, volume });
    px = close;
  }
  const ema = (n) => { const k = 2 / (n + 1); const out = []; let e = bars[0].close; for (const b of bars) { e = b.close * k + e * (1 - k); out.push(e); } return out; };
  const F = ema(20), S = ema(60);
  const atr = [];
  { let a = bars[0].high - bars[0].low; bars.forEach((b, i) => { const pc = i ? bars[i - 1].close : b.open; const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)); a = i ? a + (tr - a) / 14 : tr; atr.push(a); }); }
  const f1 = (x) => x.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const ex = REQ.execution;
  let cash = REQ.initialEquityUsdt;
  let pos = null;
  const fills = [], closedTrades = [], strategyActions = [], equityCurve = [], replaySnapshots = [];
  let pending = null;
  let lastExitIdx = -99;
  let lastSnapshotKey = "";
  const sgn = (s) => (s === "long" ? 1 : -1);
  const slip = (price, side, bps) => price * (side === "buy" ? 1 + bps / 1e4 : 1 - bps / 1e4);
  const notional = (q, p) => q * CT_VAL * p;
  function openPos(side, qty, t, raw, reason) {
    const fs = side === "long" ? "buy" : "sell";
    const fp = slip(raw, fs, ex.entrySlippageBps);
    const fee = notional(qty, fp) * ex.entryFeeRate;
    const margin = notional(qty, fp) / REQ.leverage * REQ.marginSafetyMultiplier;
    cash -= fee;
    pos = { side, quantity: qty, entryTimeMs: t, averageEntryPrice: fp, entryFeeUsdt: fee, usedMarginUsdt: margin, stopLoss: null, takeProfit: null, scaled: false };
    fills.push({ timeMs: t, instId: REQ.instId, side: fs, quantity: qty, rawPrice: raw, fillPrice: fp, notionalUsdt: notional(qty, fp), feeUsdt: fee, marginDeltaUsdt: margin, marginAfterUsdt: margin, reason });
  }
  function closeQty(q, t, raw, reason) {
    const fs = pos.side === "long" ? "sell" : "buy";
    const fp = slip(raw, fs, ex.exitSlippageBps);
    const fee = notional(q, fp) * ex.exitFeeRate;
    const alloc = q / pos.quantity;
    const aFee = pos.entryFeeUsdt * alloc, aMargin = pos.usedMarginUsdt * alloc;
    const gross = sgn(pos.side) * q * CT_VAL * (fp - pos.averageEntryPrice);
    const net = gross - aFee - fee;
    cash += gross - fee;
    fills.push({ timeMs: t, instId: REQ.instId, side: fs, quantity: q, rawPrice: raw, fillPrice: fp, notionalUsdt: notional(q, fp), feeUsdt: fee, marginDeltaUsdt: -aMargin, marginAfterUsdt: Math.max(0, pos.usedMarginUsdt - aMargin), reason });
    closedTrades.push({ strategyId, instId: REQ.instId, side: pos.side, quantity: q, entryTimeMs: pos.entryTimeMs, exitTimeMs: t, entryPrice: pos.averageEntryPrice, exitPrice: fp, entryNotionalUsdt: notional(q, pos.averageEntryPrice), exitNotionalUsdt: notional(q, fp), usedMarginUsdt: aMargin, leverage: REQ.leverage, marginSafetyMultiplier: REQ.marginSafetyMultiplier, grossPnlUsdt: gross, entryFeeUsdt: aFee, exitFeeUsdt: fee, fundingCashflowUsdt: 0, netPnlUsdt: net, exitReason: reason });
    const rem = pos.quantity - q;
    if (rem <= 1e-9) pos = null;
    else { pos.quantity = rem; pos.entryFeeUsdt -= aFee; pos.usedMarginUsdt -= aMargin; }
  }
  const unreal = (mark) => (pos ? sgn(pos.side) * pos.quantity * CT_VAL * (mark - pos.averageEntryPrice) : 0);

  for (let i = PRE - 1; i < N; i++) {
    const b = bars[i];
    if (i >= PRE) {
      if (pending) {
        const a = pending; pending = null;
        const t = b.openTimeMs;
        if (a.kind === "open_long" || a.kind === "open_short") {
          if (!pos) {
            const budget = cash * REQ.positionSizing.perEntryBudget / 100 * REQ.leverage;
            const qty = Math.max(1, Math.floor(budget / (b.open * CT_VAL)));
            openPos(a.kind === "open_long" ? "long" : "short", qty, t, b.open, "targetIncrease");
            pos.stopLoss = a.protection.stopLoss;
            pos.atr0 = a.atr0;
          }
        } else if ((a.kind === "close_long" || a.kind === "close_short") && pos) {
          const q = a.quantity ? Math.min(a.quantity, pos.quantity) : pos.quantity;
          closeQty(q, t, b.open, "targetDecrease");
          if (pos) pos.scaled = true; else lastExitIdx = i;
        } else if (a.kind === "set_protection" && pos) {
          pos.stopLoss = a.stopLoss;
        }
      }
      if (pos && pos.stopLoss != null) {
        const hitLong = pos.side === "long" && b.low <= pos.stopLoss;
        const hitShort = pos.side === "short" && b.high >= pos.stopLoss;
        if (hitLong || hitShort) {
          const gap = pos.side === "long" ? b.open <= pos.stopLoss : b.open >= pos.stopLoss;
          closeQty(pos.quantity, b.closeTimeMs, gap ? b.open : pos.stopLoss, "protectiveStop");
          lastExitIdx = i;
        }
      }
      const u = unreal(b.close);
      const equity = cash + u;
      const used = pos ? pos.usedMarginUsdt : 0;
      equityCurve.push({ timeMs: b.closeTimeMs, equityUsdt: equity, realizedCashUsdt: cash, unrealizedPnlUsdt: u });
      // Snapshots are recorded only where position state changes (like the engine).
      const key = pos ? `${pos.side}:${pos.quantity}:${pos.stopLoss}:${fills.length}` : `flat:${fills.length}`;
      if (key !== lastSnapshotKey) {
        lastSnapshotKey = key;
        replaySnapshots.push({
          timeMs: b.closeTimeMs, equityUsdt: equity, cashUsdt: cash, unrealizedPnlUsdt: u, usedMarginUsdt: used, availableMarginUsdt: equity - used,
          fillCount: fills.length, closedTradeCount: closedTrades.length, fundingPaymentCount: 0,
          position: pos ? { strategyId, instId: REQ.instId, side: pos.side, quantity: pos.quantity, entryTimeMs: pos.entryTimeMs, averageEntryPrice: pos.averageEntryPrice, markedPrice: b.close, contractValue: CT_VAL, notionalUsdt: notional(pos.quantity, b.close), usedMarginUsdt: used, leverage: REQ.leverage, marginSafetyMultiplier: REQ.marginSafetyMultiplier, unrealizedPnlUsdt: u, entryFeeUsdt: pos.entryFeeUsdt, fundingCashflowUsdt: 0, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit } : null,
        });
      }
    }
    if (i === N - 1) break;
    const t = b.closeTimeMs;
    const up = F[i] > S[i], slopeS = (S[i] - S[i - 8]) / S[i - 8];
    const push = (action) => { strategyActions.push({ asOfMs: t, action }); pending = action; };
    if (!pos) {
      let crossAge = 99;
      for (let k = 0; k < 16; k++) { if ((F[i - k] > S[i - k]) !== (F[i - k - 1] > S[i - k - 1])) { crossAge = k; break; } }
      if (i - lastExitIdx >= 8 && crossAge < 16) {
        if (up && b.close > F[i] && slopeS > 0.0004) {
          push({ kind: "open_long", reason: `EMA20 ${f1(F[i])} 在 EMA60 ${f1(S[i])} 之上，收盘站上快线，慢线 8 根斜率 +${(slopeS * 100).toFixed(2)}%`, protection: { stopLoss: b.close - 2.5 * atr[i] }, atr0: atr[i] });
        } else if (!up && b.close < F[i] && slopeS < -0.0004) {
          push({ kind: "open_short", reason: `EMA20 ${f1(F[i])} 在 EMA60 ${f1(S[i])} 之下，收盘跌破快线，慢线 8 根斜率 ${(slopeS * 100).toFixed(2)}%`, protection: { stopLoss: b.close + 2.5 * atr[i] }, atr0: atr[i] });
        }
      }
    } else {
      const long = pos.side === "long";
      const gainAtr = sgn(pos.side) * (b.close - pos.averageEntryPrice) / pos.atr0;
      const crossedAgainst = long ? F[i] < S[i] : F[i] > S[i];
      if (crossedAgainst) {
        push({ kind: long ? "close_long" : "close_short", reason: `EMA20 ${long ? "下穿" : "上穿"} EMA60（${f1(F[i])} / ${f1(S[i])}），趋势失效，全部平仓` });
      } else if (!pos.scaled && gainAtr >= 2.6) {
        const q = Math.floor(pos.quantity / 2);
        if (q >= 1) push({ kind: long ? "close_long" : "close_short", quantity: q, reason: `浮盈 ${gainAtr.toFixed(1)}×ATR，减仓 50% 锁定利润` });
      } else if (pos.scaled && !pos.beMoved) {
        pos.beMoved = true;
        const be = pos.averageEntryPrice * (long ? 1.0006 : 0.9994);
        push({ kind: "set_protection", stopLoss: be, reason: `剩余仓位止损移至 ${f1(be)}（开仓价 + 费用），保本持有` });
      } else if (pos.scaled && pos.beMoved) {
        const trail = long ? b.close - 3.2 * atr[i] : b.close + 3.2 * atr[i];
        const better = long ? trail > pos.stopLoss + 0.9 * atr[i] : trail < pos.stopLoss - 0.9 * atr[i];
        if (better) push({ kind: "set_protection", stopLoss: trail, reason: `追踪止损${long ? "上调" : "下移"}至 ${f1(trail)}（收盘 ${long ? "−" : "+"} 3.2×ATR）` });
      }
    }
  }
  if (pos) {
    const last = bars[N - 1];
    closeQty(pos.quantity, last.closeTimeMs, last.close, "endOfRunClose");
    const e = equityCurve[equityCurve.length - 1];
    e.equityUsdt = cash; e.realizedCashUsdt = cash; e.unrealizedPnlUsdt = 0;
    replaySnapshots.push({ timeMs: last.closeTimeMs, equityUsdt: cash, cashUsdt: cash, unrealizedPnlUsdt: 0, usedMarginUsdt: 0, availableMarginUsdt: cash, fillCount: fills.length, closedTradeCount: closedTrades.length, fundingPaymentCount: 0, position: null });
    // Replace a same-time transition row, if any, with the post-close state.
    const byTime = new Map(replaySnapshots.map((s) => [s.timeMs, s]));
    replaySnapshots.length = 0;
    replaySnapshots.push(...[...byTime.values()].sort((a, b) => a.timeMs - b.timeMs));
  }
  const actionsOut = strategyActions.map((a) => ({ asOfMs: a.asOfMs, action: { kind: a.action.kind, quantity: a.action.quantity, reason: a.action.reason } }));

  const init = REQ.initialEquityUsdt;
  const finalEq = equityCurve[equityCurve.length - 1].equityUsdt;
  let hwm = init, maxDdU = 0, maxDdP = 0;
  for (const p of equityCurve) { hwm = Math.max(hwm, p.equityUsdt); const dd = hwm - p.equityUsdt; if (dd > maxDdU) maxDdU = dd; if (dd / hwm > maxDdP) maxDdP = dd / hwm; }
  const nets = closedTrades.map((t) => t.netPnlUsdt);
  const wins = nets.filter((x) => x > 0), losses = nets.filter((x) => x <= 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const fees = sum(fills.map((f) => f.feeUsdt));
  const rets = []; for (let i = 1; i < equityCurve.length; i++) rets.push(equityCurve[i].equityUsdt / equityCurve[i - 1].equityUsdt - 1);
  const mean = sum(rets) / rets.length;
  const sd = Math.sqrt(sum(rets.map((x) => (x - mean) ** 2)) / (rets.length - 1));
  const dsd = Math.sqrt(sum(rets.map((x) => Math.min(0, x) ** 2)) / (rets.length - 1));
  const ANN = 365 * 1440;
  let streakW = 0, streakL = 0, cw = 0, cl = 0;
  for (const x of nets) { if (x > 0) { cw++; cl = 0; } else { cl++; cw = 0; } streakW = Math.max(streakW, cw); streakL = Math.max(streakL, cl); }
  let exposureBars = 0;
  { let open = false, k = 0; for (const p of equityCurve) { while (k < replaySnapshots.length && replaySnapshots[k].timeMs <= p.timeMs) { open = Boolean(replaySnapshots[k].position); k++; } if (open) exposureBars++; } }
  const report = {
    metrics: {
      initialEquityUsdt: init, finalEquityUsdt: finalEq, netPnlUsdt: finalEq - init,
      grossPnlUsdt: sum(closedTrades.map((t) => t.grossPnlUsdt)), realizedGrossPnlUsdt: sum(closedTrades.map((t) => t.grossPnlUsdt)), unrealizedPnlUsdt: 0,
      feesUsdt: fees, fundingCashflowUsdt: 0, maxDrawdownUsdt: maxDdU, maxDrawdownPct: maxDdP * 100,
      closedTradeCount: closedTrades.length, winRate: wins.length / Math.max(1, nets.length),
    },
    equityCurve, replaySnapshots,
    statistics: {
      annualizedSharpe: mean / sd * Math.sqrt(ANN), annualizedSortino: mean / dsd * Math.sqrt(ANN), annualizedVolatilityPct: sd * Math.sqrt(ANN) * 100,
      profitFactor: sum(wins) / Math.abs(sum(losses) || 1), expectancyUsdt: sum(nets) / Math.max(1, nets.length),
      averageWinUsdt: wins.length ? sum(wins) / wins.length : null, averageLossUsdt: losses.length ? sum(losses) / losses.length : null,
      payoffRatio: wins.length && losses.length ? (sum(wins) / wins.length) / Math.abs(sum(losses) / losses.length) : null,
      averageHoldingMs: sum(closedTrades.map((t) => t.exitTimeMs - t.entryTimeMs)) / Math.max(1, closedTrades.length),
      exposurePct: exposureBars / equityCurve.length * 100,
      largestWinUsdt: nets.length ? Math.max(...nets) : null, largestLossUsdt: nets.length ? Math.min(...nets) : null,
      maxConsecutiveWins: streakW, maxConsecutiveLosses: streakL,
    },
    fills, closedTrades, strategyActions: actionsOut, limitOrderFillModel: null, equitySeriesArchived: false, reportHash: `fixture-${seed}-${EVAL}`,
  };
  const evalBars = bars.slice(PRE);
  const finishedAt = evalBars.at(-1).closeTimeMs + 3_600_000;
  const run = {
    id: "run-fixture",
    strategyId,
    strategyName,
    strategyVersion: 3,
    status: "completed",
    progressPct: 100,
    instId: REQ.instId,
    dataSnapshotId: "fixture",
    barCount: EVAL,
    createdAt: finishedAt - 40_000,
    startedAt: finishedAt - 39_000,
    finishedAt,
    metrics: {
      netReturnPct: (finalEq / init - 1) * 100,
      maxDrawdownPct: maxDdP * 100,
      annualizedSharpe: report.statistics.annualizedSharpe,
      closedTradeCount: closedTrades.length,
      winRate: report.metrics.winRate,
      feesUsdt: fees,
      fundingCashflowUsdt: 0,
    },
    equityPreview: equityCurve.filter((_, index) => index % Math.max(1, Math.floor(equityCurve.length / 24)) === 0).map((p) => p.equityUsdt),
    timing: null,
  };
  const request = {
    strategyId, strategyVersion: 3, instId: REQ.instId, startAt: evalBars[0].openTimeMs, endAt: evalBars.at(-1).closeTimeMs,
    initialEquityUsdt: init, preloadBars: PRE, execution: REQ.execution, leverage: REQ.leverage, marginSafetyMultiplier: 1,
    positionSizing: REQ.positionSizing, endOfRunPolicy: REQ.endOfRunPolicy,
  };
  return { run, request, report, evalBars, preloadBars: PRE, preloadStartAt: bars[0].openTimeMs, rounds: new Set(closedTrades.map((t) => `${t.entryTimeMs}:${t.side}`)).size };
}

function sampleEquityContext(points, maximum) {
  if (maximum <= 0 || !points.length) return [];
  if (points.length <= maximum) return points.slice();
  if (maximum === 1) return [points[points.length - 1]];
  const sampled = [points[0], points[points.length - 1]];
  const buckets = Math.floor((maximum - 2) / 2);
  if (!buckets || points.length <= 2) return sampled;
  const interior = points.length - 2;
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = 1 + Math.floor((bucket * interior) / buckets);
    const end = 1 + Math.floor(((bucket + 1) * interior) / buckets);
    if (start >= end) continue;
    const slice = points.slice(start, end);
    let min = slice[0], max = slice[0];
    for (const p of slice) { if (p.equityUsdt < min.equityUsdt) min = p; if (p.equityUsdt > max.equityUsdt) max = p; }
    sampled.push(min);
    if (min.timeMs !== max.timeMs) sampled.push(max);
  }
  return sampled;
}

/** Mirrors `systematic_backtest_detail` + `backtest_replay_projection`. */
export function detailPage(fixture, request = {}) {
  const { run, request: reproduction, report, evalBars, preloadBars, preloadStartAt } = fixture;
  const total = evalBars.length;
  const limit = Math.min(MAX_REPLAY_BAR_LIMIT, Math.max(1, request.limit ?? DEFAULT_REPLAY_BAR_LIMIT));
  const offset = Math.min(total, request.offset ?? Math.max(0, total - limit));
  const bars = evalBars.slice(offset, Math.min(total, offset + limit));
  const start = bars[0]?.closeTimeMs;
  const end = bars.at(-1)?.closeTimeMs;
  const inWindow = (t) => start !== undefined && t >= start && t <= end;
  const carryIn = start === undefined ? undefined : [...report.replaySnapshots].reverse().find((s) => s.timeMs < start);
  const active = report.equityCurve.filter((p) => inWindow(p.timeMs));
  const byTime = new Map();
  for (const p of sampleEquityContext(report.equityCurve, MAX_REPLAY_EQUITY_POINT_LIMIT - active.length)) if (!byTime.has(p.timeMs)) byTime.set(p.timeMs, p);
  for (const p of active) byTime.set(p.timeMs, p);
  return {
    run,
    request: reproduction,
    report: {
      metrics: report.metrics,
      equityCurve: start === undefined ? [] : [...byTime.values()].sort((a, b) => a.timeMs - b.timeMs),
      replaySnapshots: start === undefined ? [] : [...(carryIn ? [carryIn] : []), ...report.replaySnapshots.filter((s) => inWindow(s.timeMs))],
      statistics: report.statistics,
      fills: end === undefined ? [] : report.fills.filter((f) => f.timeMs <= end),
      closedTrades: end === undefined ? [] : report.closedTrades.filter((t) => t.exitTimeMs <= end),
      strategyActions: report.strategyActions.filter((a) => inWindow(a.asOfMs) && a.action.kind !== "no_action"),
      limitOrderFillModel: null,
      equitySeriesArchived: false,
      reportHash: report.reportHash,
    },
    bars,
    barOffset: offset,
    totalBarCount: total,
    preloadBarCount: preloadBars,
    preloadStartAt,
    evaluationStartAt: evalBars[0].openTimeMs,
    evaluationEndAt: evalBars.at(-1).closeTimeMs,
  };
}
