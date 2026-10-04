import assert from "node:assert/strict";
import { buildReviewTrades, buildHeatmap, computeExcursion, deriveFindings, describeTrade, leverageBuckets, mapSource, matchesFilter, replayBar, stopBuckets, MIN_SAMPLE } from "../src/lib/tradeReviewModel.ts";

const T0 = new Date("2026-09-01T10:00:00+08:00").getTime();
const MIN = 60_000;
let seq = 0;
const ep = (over = {}) => ({
  id: `pe-${++seq}`, accountId: "a", environment: "demo", instType: "SWAP", instId: "BTC-USDT-SWAP", episodeSide: "long", status: "closed", primaryOrigin: "user",
  openTime: T0, closeTime: T0 + 60 * MIN, openQty: "1", maxQty: "1", closedQty: "1", remainingQty: "0", avgOpenPx: "60000", avgClosePx: "60600", realizedPnl: "10", fees: "1", fundingFee: "0", netPnl: "9", initialLever: "5", events: [], ...over,
});
const text = (zh) => zh;

// 来源映射
assert.equal(mapSource("user"), "manual"); assert.equal(mapSource("ai"), "ai"); assert.equal(mapSource("exchange"), "exchange"); assert.equal(mapSource("???"), "unknown"); assert.equal(mapSource(null), "unknown");

// 只取已平仓、有净盈亏的；按开仓时间升序
const mixed = buildReviewTrades([
  ep({ openTime: T0 + 200 * MIN, closeTime: T0 + 260 * MIN }),
  ep({ status: "open", closeTime: null }),
  ep({ netPnl: null, realizedPnl: null }),
  ep({ openTime: T0, closeTime: T0 + 30 * MIN }),
]);
assert.equal(mixed.length, 2); assert.ok(mixed[0].openTime < mixed[1].openTime);
assert.equal(mixed[0].leverage, 5);
// 净盈亏缺失时退回已实现盈亏
assert.equal(buildReviewTrades([ep({ netPnl: null, realizedPnl: "-3" })])[0].netPnl, -3);

// 追单：上一笔亏损平仓后 30 分钟内；盈利后不算；跨品种也算；超过窗口不算
const chain = buildReviewTrades([
  ep({ id: "a", openTime: T0, closeTime: T0 + 60 * MIN, netPnl: "-20" }),
  ep({ id: "b", instId: "ETH-USDT-SWAP", openTime: T0 + 70 * MIN, closeTime: T0 + 100 * MIN, netPnl: "5" }),   // 亏后 10 分钟 → 追单
  ep({ id: "c", openTime: T0 + 110 * MIN, closeTime: T0 + 130 * MIN, netPnl: "-4" }),                           // 上一笔盈利 → 不算
  ep({ id: "d", openTime: T0 + 200 * MIN, closeTime: T0 + 220 * MIN, netPnl: "1" }),                            // 亏后 70 分钟 → 不算
]);
assert.deepEqual(chain.map((t) => t.revenge), [false, true, false, false]);
assert.equal(chain[1].gapMs, 10 * MIN);
assert.equal(chain[0].gapMs, null);

// 笔记与止损匹配并入
const withMeta = buildReviewTrades([ep({ id: "x" }), ep({ id: "y" })], [{ episodeId: "x", tags: ["突破"], note: "没等回踩", updatedAt: 1 }], [{ episodeId: "y", hadStop: true, stopPx: 59000, tpPx: 63000, stopTriggered: true }]);
assert.deepEqual(withMeta.find((t) => t.id === "x").tags, ["突破"]);
assert.equal(withMeta.find((t) => t.id === "x").hadStop, undefined, "没匹配过就是 undefined，而不是 false");
assert.equal(withMeta.find((t) => t.id === "y").hadStop, true);

// 热力图 / 分档
const many = (n, make) => Array.from({ length: n }, (_, i) => ep(make(i)));
const heat = buildHeatmap(buildReviewTrades(many(3, (i) => ({ openTime: T0 + i * MIN, closeTime: T0 + (i + 1) * MIN, netPnl: "2" }))));
assert.equal(heat.flat().reduce((a, c) => a + c.n, 0), 3);
const lev = leverageBuckets(buildReviewTrades([...many(6, () => ({ initialLever: "2" })), ...many(5, () => ({ initialLever: "20", netPnl: "-1" })), ep({ initialLever: null })]));
assert.deepEqual(lev.map((b) => [b.key, b.trades.length, b.enough]), [["≤3x", 6, true], ["4–10x", 0, false], [">10x", 5, true]], "杠杆未知的不参与；样本不足标记 enough=false");

// 体检结论：追单 / 没止损 / 最稳品种；样本不足不下结论；最多 3 条且好消息在后
let t = T0; const rows = [];
for (let i = 0; i < 6; i += 1) { rows.push(ep({ id: `l${i}`, openTime: t, closeTime: t + 20 * MIN, netPnl: "-10", instId: "SOL-USDT-SWAP" })); t += 25 * MIN; rows.push(ep({ id: `r${i}`, openTime: t, closeTime: t + 15 * MIN, netPnl: "-5", instId: "SOL-USDT-SWAP" })); t += 6 * 60 * MIN; }
for (let i = 0; i < 8; i += 1) { rows.push(ep({ id: `b${i}`, openTime: t, closeTime: t + 30 * MIN, netPnl: i < 7 ? "20" : "-3" })); t += 8 * 60 * MIN; }
const trades = buildReviewTrades(rows);
const findings = deriveFindings(trades, text);
assert.ok(findings.length <= 3);
assert.equal(findings[0].id, "revenge"); assert.equal(findings[0].filter, "revenge");
assert.match(findings[0].title, /30 分钟内又开仓：6 笔/);
assert.equal(findings.at(-1).tone, "ok", "好消息排在警告之后"); assert.match(findings.at(-1).title, /BTC 是你最稳的品种/);
// 每条结论都能点开对应交易
for (const f of findings) { if (f.filter) assert.equal(trades.filter((tr) => matchesFilter(tr, f.filter)).length, f.count, `${f.id} 的计数必须等于筛选结果`); }
assert.equal(deriveFindings(trades.slice(0, 3), text).length, 0, "样本不足不下结论");
assert.ok(MIN_SAMPLE >= 5);

// 止损对比要求匹配覆盖率 ≥ 50%
const stopRows = [...many(6, (i) => ({ id: `s${i}`, netPnl: "10", openTime: T0 + i * 600 * MIN, closeTime: T0 + i * 600 * MIN + 30 * MIN })), ...many(6, (i) => ({ id: `n${i}`, netPnl: "-10", openTime: T0 + (20 + i) * 600 * MIN, closeTime: T0 + (20 + i) * 600 * MIN + 30 * MIN }))];
const prot = [...Array(6).keys()].map((i) => ({ episodeId: `s${i}`, hadStop: true, stopPx: 59000, tpPx: null, stopTriggered: false })).concat([...Array(6).keys()].map((i) => ({ episodeId: `n${i}`, hadStop: false, stopPx: null, tpPx: null, stopTriggered: false })));
const stopTrades = buildReviewTrades(stopRows, [], prot);
assert.ok(stopBuckets(stopTrades).coverage === 1);
assert.ok(deriveFindings(stopTrades, text).some((f) => f.id === "nostop"));
assert.equal(deriveFindings(buildReviewTrades(stopRows, [], prot.slice(0, 2)), text).some((f) => f.id === "nostop"), false, "覆盖率不足不下结论");

// 单笔：MAE / MFE / 止损被扫（K 线 time 是秒）
const trade = buildReviewTrades([ep({ openTime: 1_000_000, closeTime: 1_000_000 + 60 * MIN, avgOpenPx: "100", avgClosePx: "99", netPnl: "-5" })], [], [{ episodeId: `pe-${seq}`, hadStop: true, stopPx: 99, tpPx: 103, stopTriggered: true }])[0];
const c = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 1, confirm: true });
const candles = [c(1000, 100, 101, 98.5, 99.5), c(1000 + 1800, 99.5, 100.5, 98.9, 99), c(1000 + 3600 + 600, 99, 103.5, 98.8, 103)];   // 平仓后一根冲到 103.5
const ex = computeExcursion(trade, candles);
assert.ok(ex.maePct < -1 && ex.mfePct > 0.9); assert.equal(ex.reachedTargetAfter, true);
const verdicts = describeTrade(trade, ex, text);
assert.ok(verdicts.some((v) => /止损被触发后/.test(v.text)), "止损被扫要被点出来");
assert.equal(computeExcursion({ ...trade, entry: null }, candles), null);
assert.equal(computeExcursion(trade, []), null);
assert.equal(replayBar(30 * MIN), "5m"); assert.equal(replayBar(5 * 3600_000), "15m"); assert.equal(replayBar(48 * 3600_000), "1H"); assert.equal(replayBar(200 * 3600_000), "4H");
console.log("trade review model tests passed");
