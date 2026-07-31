import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_BARS = {
  "5m": { stepMs: 5 * 60_000, days: 7 },
  "30m": { stepMs: 30 * 60_000, days: 30 },
  "1H": { stepMs: 60 * 60_000, days: 60 },
  "2H": { stepMs: 2 * 60 * 60_000, days: 120 },
  "4H": { stepMs: 4 * 60 * 60_000, days: 365 },
  "12H": { stepMs: 12 * 60 * 60_000, days: 730 }
};

function workspaceRoot() {
  return process.cwd();
}

function loadSymbols() {
  const watchlistPath = path.join(workspaceRoot(), "config", "watchlist.local.json");
  if (!fs.existsSync(watchlistPath)) return ["BTC-USDT-SWAP"];
  const parsed = JSON.parse(fs.readFileSync(watchlistPath, "utf8"));
  if (!Array.isArray(parsed.symbols) || parsed.symbols.length === 0) return ["BTC-USDT-SWAP"];
  return Array.from(new Set(parsed.symbols.map((item) => String(item).trim().toUpperCase()).filter(Boolean))).slice(0, 10);
}

function sqlitePath() {
  if (process.platform === "win32" && process.env.APPDATA) {
    for (const identifier of ["com.desic.terminal", "com.desic.tradeai"]) {
      const appDb = path.join(process.env.APPDATA, identifier, "desic_trade_ai.sqlite3");
      if (fs.existsSync(appDb)) return appDb;
    }
  }
  if (process.platform === "darwin" && process.env.HOME) {
    for (const identifier of ["com.desic.terminal", "com.desic.tradeai"]) {
      const macDb = path.join(process.env.HOME, "Library", "Application Support", identifier, "desic_trade_ai.sqlite3");
      if (fs.existsSync(macDb)) return macDb;
    }
  }
  const localDb = path.join(workspaceRoot(), "desic_trade_ai.sqlite3");
  if (fs.existsSync(localDb)) return localDb;
  throw new Error("desktop sqlite database missing");
}

function runSql(dbPath, sql) {
  const result = spawnSync("sqlite3", [dbPath, "-json", sql], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || "[]");
}

function alignOpen(valueMs, stepMs) {
  return alignOpenWithOffset(valueMs, stepMs, 0);
}

function klineOpenOffsetMs(bar, stepMs) {
  if (bar === "6H" || bar === "12H" || bar === "1D") return (16 * 60 * 60_000) % stepMs;
  return 0;
}

function alignOpenWithOffset(valueMs, stepMs, offsetMs) {
  return valueMs - (((valueMs - offsetMs) % stepMs) + stepMs) % stepMs;
}

function expectedCount(startOpen, endOpen, stepMs) {
  return Math.floor((endOpen - startOpen) / stepMs) + 1;
}

function auditSymbolBar(dbPath, symbol, bar, config, nowMs) {
  const offsetMs = klineOpenOffsetMs(bar, config.stepMs);
  const endOpen = alignOpenWithOffset(nowMs, config.stepMs, offsetMs) - config.stepMs;
  const startOpen = alignOpenWithOffset(endOpen - config.days * 86_400_000, config.stepMs, offsetMs);
  const rows = runSql(
    dbPath,
    `SELECT open_time AS openTime,
            CAST(open AS REAL) AS open,
            CAST(high AS REAL) AS high,
            CAST(low AS REAL) AS low,
            CAST(close AS REAL) AS close,
            CAST(volume AS REAL) AS volume
     FROM candles
     WHERE symbol='${escapeSql(symbol)}'
       AND interval='${escapeSql(bar)}'
       AND open_time BETWEEN ${startOpen} AND ${endOpen}
     ORDER BY open_time ASC;`
  );
  const expected = expectedCount(startOpen, endOpen, config.stepMs);
  let gaps = 0;
  let invalid = 0;
  let duplicateOrMisordered = 0;
  let cursor = startOpen;
  let rowIndex = 0;
  while (cursor <= endOpen) {
    const row = rows[rowIndex];
    if (!row || Number(row.openTime) !== cursor) {
      gaps += 1;
      cursor += config.stepMs;
      continue;
    }
    if (
      !Number.isFinite(row.open) ||
      !Number.isFinite(row.high) ||
      !Number.isFinite(row.low) ||
      !Number.isFinite(row.close) ||
      row.high < row.low ||
      row.high < row.open ||
      row.high < row.close ||
      row.low > row.open ||
      row.low > row.close ||
      !Number.isFinite(row.volume) ||
      row.volume < 0
    ) {
      invalid += 1;
    }
    rowIndex += 1;
    cursor += config.stepMs;
  }
  duplicateOrMisordered = rows.length - rowIndex;
  return {
    symbol,
    bar,
    expected,
    existing: rows.length,
    gaps,
    invalid,
    duplicateOrMisordered,
    startOpen,
    endOpen,
    first: rows[0]?.openTime ?? null,
    last: rows.at(-1)?.openTime ?? null
  };
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}

function main() {
  const dbPath = sqlitePath();
  const symbols = loadSymbols();
  const nowMs = Date.now();
  const results = [];
  const failures = [];
  for (const symbol of symbols) {
    for (const [bar, config] of Object.entries(REQUIRED_BARS)) {
      const result = auditSymbolBar(dbPath, symbol, bar, config, nowMs);
      results.push(result);
      if (result.gaps > 0 || result.invalid > 0 || result.duplicateOrMisordered > 0) {
        failures.push(result);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`local kline integrity failed: ${JSON.stringify(failures.slice(0, 8))}`);
  }
  process.stdout.write(`[smoke] local kline integrity ok: db=${dbPath} symbols=${symbols.length} checks=${results.length} ${JSON.stringify(results)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[smoke] local kline integrity failed: ${error?.message || String(error)}\n`);
  process.exit(1);
}
