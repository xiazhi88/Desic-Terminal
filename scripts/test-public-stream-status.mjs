import assert from "node:assert/strict";
import {
  formatPublicStreamChannelNote,
  publicStreamAgeMs,
  publicStreamQueueLagMs
} from "../src/lib/publicStreamStatus.ts";

// Same contract as src/lib/format.ts#fmtDelay, injected so this test does not
// need the app's i18n runtime graph.
function fmtDelay(delayMs) {
  if (delayMs == null || !Number.isFinite(delayMs)) return "--";
  if (delayMs < 1000) return `${Math.max(0, Math.round(delayMs))}ms`;
  return `${(delayMs / 1000).toFixed(2)}s`;
}

const labels = { trades: "成交", queue: "本地排队" };

// A fresh ticker whose status snapshot is old must not add the two ages up.
assert.equal(
  publicStreamAgeMs({ delayMs: 120, lastReceivedAt: 90_000, eventAt: 90_000 }, 100_000),
  10_000,
  "the larger of the two ages wins, never their sum"
);
assert.equal(
  publicStreamAgeMs({ delayMs: 28_720, lastReceivedAt: 99_500 }, 100_000),
  28_720,
  "an old data age is reported as-is"
);
assert.equal(
  publicStreamAgeMs({ lastReceivedAt: 99_500 }, 100_000),
  500,
  "snapshot age is the only signal when delayMs is absent"
);
assert.equal(
  publicStreamAgeMs({ eventAt: 1_000 }, 100_000),
  undefined,
  "no freshness signal means no number"
);
assert.equal(
  publicStreamAgeMs({ delayMs: -5, lastReceivedAt: 100_500 }, 100_000),
  0,
  "clock skew never yields a negative age"
);

// Queue lag is local backlog and stays separate from the data age.
assert.equal(publicStreamQueueLagMs({ queueLagMs: 499 }), undefined, "sub-500ms jitter stays hidden");
assert.equal(publicStreamQueueLagMs({ queueLagMs: 15_400 }), 15_400);
assert.equal(publicStreamQueueLagMs({}), undefined);
assert.equal(
  publicStreamAgeMs({ delayMs: 120, queueLagMs: 15_400, lastReceivedAt: 99_900 }, 100_000),
  120,
  "queue lag must not inflate the reported data age"
);

// The meta row shows ticker age plus the other channels as secondary readings.
assert.equal(
  formatPublicStreamChannelNote({ tradesDelayMs: 1_200, queueLagMs: 15_400 }, fmtDelay, labels),
  "成交 1.20s · 本地排队 15.40s"
);
assert.equal(
  formatPublicStreamChannelNote({ tradesDelayMs: 900, queueLagMs: 120 }, fmtDelay, labels),
  "成交 900ms"
);
assert.equal(formatPublicStreamChannelNote({ queueLagMs: 4_500 }, fmtDelay, labels), "本地排队 4.50s");
assert.equal(formatPublicStreamChannelNote({}, fmtDelay, labels), undefined);
assert.equal(
  formatPublicStreamChannelNote({ tradesDelayMs: Number.NaN }, fmtDelay, labels),
  undefined,
  "non-finite readings are ignored"
);

console.log("public stream status semantics: ok");
