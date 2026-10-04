import assert from "node:assert/strict";
import { computeStats, cumulativeCurve, dailyCells, describeScope, EMPTY_FILTERS, groupBy, isSingleDay, selectTrades, toggleDay, dayStart } from "../src/lib/performanceExplorer.ts";

const DAY = 86_400_000;
const base = new Date("2026-09-10T12:00:00").getTime();
let seq = 0;
const trade = (over = {}) => ({ id: `t${++seq}`, instId: "BTC-USDT-SWAP", base: "BTC", side: "long", source: "manual", openTime: base - 3600_000, closeTime: base, holdMs: 3600_000, leverage: 5, entry: 1, exit: 1, netPnl: 10, fees: 1, fundingFee: 0, adds: 0, revenge: false, gapMs: null, tags: [], note: "", ...over });
const window = [base - 10 * DAY, base + DAY];
const filters = (over = {}) => ({ ...EMPTY_FILTERS, ...over });

const trades = [
  trade({ netPnl: 50, source: "manual", base: "BTC", closeTime: base - 5 * DAY }),
  trade({ netPnl: -20, source: "manual", base: "ETH", closeTime: base - 4 * DAY }),
  trade({ netPnl: 30, source: "ai", base: "BTC", closeTime: base - 2 * DAY }),
  trade({ netPnl: -40, source: "ai", base: "SOL", closeTime: base - 1 * DAY }),
  trade({ netPnl: 5, source: "strategy", base: "BTC", closeTime: base - 30 * DAY }), // 窗口外
];

// 窗口与三维筛选
assert.equal(selectTrades(trades, window, filters()).length, 4);
assert.equal(selectTrades(trades, window, filters({ sources: new Set(["manual"]) })).length, 2);
assert.equal(selectTrades(trades, window, filters({ sources: new Set(["manual"]), symbols: new Set(["BTC"]) })).length, 1);
assert.equal(selectTrades(trades, window, filters({ time: [base - 3 * DAY, base] })).length, 2);
assert.equal(selectTrades(trades, window, filters({ symbols: new Set(["BTC"]) }), ["symbol"]).length, 4, "skip 维度不参与");

// 统计
const s = computeStats(trades.slice(0, 4));
assert.equal(s.count, 4); assert.equal(s.net, 20); assert.equal(s.winRate, 50);
assert.ok(Math.abs(s.profitFactor - 80 / 60) < 1e-9);
assert.equal(s.maxDrawdown, 40); // 峰值 +60（50-20+30=60）后 -40
assert.equal(computeStats([]).winRate, null); assert.equal(computeStats([]).profitFactor, null); assert.equal(computeStats([trade({ netPnl: 5 })]).profitFactor, null);

// 曲线：末值等于净盈亏，且单调按时间累计
const curve = cumulativeCurve(trades.slice(0, 4), window, 20);
assert.equal(curve.length, 20); assert.equal(curve[19], 20); assert.equal(curve[0], 0);
assert.deepEqual(cumulativeCurve([], window, 5), [0, 0, 0, 0, 0]);

// 交叉联动：选了 manual 后，品种分组只含 manual 的交易；来源分组不受来源筛选影响
const f = filters({ sources: new Set(["manual"]) });
const symbols = Object.fromEntries(groupBy(trades, window, f, "symbol").map((r) => [r.key, r.stats.net]));
assert.deepEqual(symbols, { BTC: 50, ETH: -20 });
const sources = Object.fromEntries(groupBy(trades, window, f, "source").map((r) => [r.key, r.stats.net]));
assert.deepEqual(sources, { manual: 30, ai: -10 });
// 已选但交叉后没有交易的取值仍保留
const kept = groupBy(trades, window, filters({ sources: new Set(["manual"]), symbols: new Set(["SOL"]) }), "symbol").find((r) => r.key === "SOL");
assert.ok(kept && kept.stats.count === 0);

// 日历
const cells = dailyCells(trades.slice(0, 4), window);
assert.equal(cells.length, 12);
assert.equal(cells.filter((c) => c.net !== null).length, 4);
assert.equal(cells.find((c) => c.start === dayStart(base - 5 * DAY)).net, 50);
assert.equal(toggleDay(null, cells[3].start)[0], cells[3].start);
assert.equal(toggleDay(toggleDay(null, cells[3].start), cells[3].start), null);
assert.ok(isSingleDay(toggleDay(null, cells[3].start))); assert.ok(!isSingleDay([base - 3 * DAY, base]));

// 范围描述
assert.equal(describeScope(filters()).filtered, false);
assert.equal(describeScope(filters({ symbols: new Set(["BTC"]) })).filtered, true);
console.log("performance explorer tests passed");
