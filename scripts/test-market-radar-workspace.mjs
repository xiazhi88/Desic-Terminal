import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyRadarFilter,
  buildMarketBreadth,
  parseNaturalRadarFilter,
} from "../src/lib/marketRadar.ts";

function row(instId, category, compositeScore, turnover24h, spreadBps, change24hPct, trendQualityScore) {
  return {
    instrument: {
      instId,
      instCategory: category,
      listTime: String(Date.now() - 2 * 24 * 60 * 60_000),
    },
    ticker: {},
    last: 100,
    change24hPct,
    amplitude24hPct: 2,
    turnover24h,
    spreadBps,
    strengthScore: 50,
    activityScore: 50,
    liquidityScore: 50,
    snapshotScore: compositeScore,
    research: {
      relativeStrength30dPct: change24hPct,
      volatility20dPct: 12,
      trendQualityScore,
    },
    compositeScore,
    rank: 1,
  };
}

const parsed = parseNaturalRadarFilter(
  "股票，成交额至少 500万，点差不超过 5bp，趋势稳定性至少 70，历史就绪",
);
assert.deepEqual(parsed.unsupported, []);
assert.equal(parsed.definition.category, "3");
assert.equal(parsed.definition.minTurnover24h, 5_000_000);
assert.equal(parsed.definition.maxSpreadBps, 5);
assert.equal(parsed.definition.minTrendQualityScore, 70);
assert.equal(parsed.definition.historyReady, true);

const rows = [
  row("AAPL-USDT-SWAP", "3", 80, 8_000_000, 2, 3, 82),
  row("TSLA-USDT-SWAP", "3", 60, 4_000_000, 3, -2, 75),
  row("BTC-USDT-SWAP", "1", 75, 100_000_000, 1, 1, 68),
];
assert.deepEqual(
  applyRadarFilter(rows, parsed.definition).map((candidate) => candidate.instrument.instId),
  ["AAPL-USDT-SWAP"],
);

const breadth = buildMarketBreadth(rows);
assert.equal(breadth[0].category, "all");
assert.equal(breadth[1].category, "1");
assert.equal(breadth[1].strengthRank, 1);
assert.equal(breadth[2].category, "3");
assert.equal(breadth[2].strengthRank, 2);

const appSource = await readFile(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
assert.match(
  appSource,
  /if \(!marketAssets\?\.instruments\?\.length\) return;[\s\S]*?startMarketRadarHistory\(\)/,
  "Market Radar history must start from the mounted App after the instrument universe is ready",
);

console.log("Market Radar deterministic filter, breadth, and background startup tests passed.");
