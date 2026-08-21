import assert from "node:assert/strict";
import { ChartDataController, updateCandleIndexes } from "../src/lib/chartDataController.ts";
import {
  MAX_RENDERED_CANDLES,
  getMarketHotState,
  mergeIntoMarketCandles,
  mergeMarketCandles,
  replaceMarketCandles,
} from "../src/lib/marketHotStore.ts";

function candle(time, confirm = false, close = time) {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 1, confirm };
}

function referenceMerge(current, incoming) {
  const merged = new Map(current.map((item) => [item.time, item]));
  for (const item of incoming) {
    const existing = merged.get(item.time);
    if (existing?.confirm && !item.confirm) continue;
    merged.set(item.time, item);
  }
  return [...merged.values()].sort((left, right) => left.time - right.time).slice(-MAX_RENDERED_CANDLES);
}

function assertSameMerge(current, incoming, label) {
  assert.deepEqual(mergeMarketCandles(current, incoming), referenceMerge(current, incoming), label);
}

const base = [candle(1, true), candle(2, false), candle(3, false)];
assertSameMerge(base, [candle(4, false)], "single candle append");
assertSameMerge(base, [candle(3, false, 33)], "latest unconfirmed update");
assertSameMerge(base, [candle(3, true, 33)], "latest candle confirmation");
assertSameMerge([candle(1, true), candle(2, true)], [candle(2, false, 22)], "confirmed candle cannot regress");
assertSameMerge(base, [candle(4, false), candle(5, false)], "strictly increasing batch append");
assertSameMerge(base, [candle(5, false), candle(4, false)], "out-of-order batch");
assertSameMerge(base, [candle(2, false, 22), candle(3, false, 33)], "duplicate timestamp batch");
assertSameMerge(base, [candle(2, true, 22)], "interior historical correction");
assertSameMerge(base, [candle(0, true)], "older historical prepend");

const controller = new ChartDataController();
const key = { symbol: "BTC-USDT-SWAP", timeframe: "1m" };
controller.replaceSnapshot(key, [candle(1, true), candle(2, false)]);
const append = controller.ingestRealtime(key, candle(3, false));
assert.equal(append.type, "append", "new candle uses append patch");
const update = controller.ingestRealtime(key, candle(3, false, 33));
assert.equal(update.type, "updateLatest", "latest candle uses updateLatest patch");
const prepend = controller.applyHistoricalPage(key, { candles: [candle(0, true)], exhausted: false });
assert.equal(prepend.type, "prepend", "older history uses prepend patch");
assert.deepEqual(controller.getCandles(key).map((item) => item.time), [0, 1, 2, 3], "controller keeps canonical order");

const repeated = controller.ingestRealtime(key, [candle(3, false, 33), candle(3, false, 33)]);
assert.equal(repeated.type, "noChange", "duplicate realtime update is ignored");

const btcKey = "BTC-USDT-SWAP\u00001m";
const trumpKey = "TRUMP-USDT-SWAP\u00001m";
replaceMarketCandles([candle(10, true, 10)], btcKey);
mergeIntoMarketCandles([candle(9, true, 9)], trumpKey);
assert.deepEqual(
  getMarketHotState().candles.map((item) => item.time),
  [10],
  "late history from another symbol is rejected"
);
mergeIntoMarketCandles([candle(9, true, 9)], btcKey);
assert.deepEqual(
  getMarketHotState().candles.map((item) => item.time),
  [9, 10],
  "history for the active symbol is merged"
);

function assertIndexes(indexed, candles, label) {
  assert.equal(indexed.map.size, candles.length, `${label}: map size`);
  assert.equal(indexed.index.size, candles.length, `${label}: index size`);
  candles.forEach((item, index) => {
    assert.equal(indexed.map.get(item.time), item, `${label}: map entry ${item.time}`);
    assert.equal(indexed.index.get(item.time), index, `${label}: index entry ${item.time}`);
  });
}

let indexed = { map: new Map(), index: new Map() };
const resetCandles = [candle(1, true), candle(2, false)];
const resetPatch = controller.replaceSnapshot(key, resetCandles);
indexed = updateCandleIndexes(indexed, resetCandles, resetPatch);
assertIndexes(indexed, resetCandles, "reset indexes");

const appendedCandles = [...resetCandles, candle(3, false)];
const appendPatch = controller.ingestRealtime(key, candle(3, false));
indexed = updateCandleIndexes(indexed, appendedCandles, appendPatch);
assertIndexes(indexed, appendedCandles, "append indexes");

const updatedCandles = [...appendedCandles.slice(0, -1), candle(3, false, 303)];
const updatePatch = controller.ingestRealtime(key, candle(3, false, 303));
indexed = updateCandleIndexes(indexed, updatedCandles, updatePatch);
assertIndexes(indexed, updatedCandles, "latest update indexes");

const prependedCandles = [candle(0, true), ...updatedCandles];
const prependPatch = controller.applyHistoricalPage(key, { candles: [candle(0, true)], exhausted: false });
indexed = updateCandleIndexes(indexed, prependedCandles, prependPatch);
assertIndexes(indexed, prependedCandles, "prepend indexes");

console.log("[kline] merge semantics ok: 10 merge cases, patch/index ordering checks passed");
