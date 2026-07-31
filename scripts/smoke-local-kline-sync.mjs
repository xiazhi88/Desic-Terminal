import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const REST_BASE = "https://openapi.okx.com";
const REQUIRED_BARS = {
  "5m": { stepMs: 5 * 60_000, days: 7 },
  "30m": { stepMs: 30 * 60_000, days: 30 },
  "1H": { stepMs: 60 * 60_000, days: 60 },
  "2H": { stepMs: 2 * 60 * 60_000, days: 120 },
  "4H": { stepMs: 4 * 60 * 60_000, days: 365 },
  "12H": { stepMs: 12 * 60 * 60_000, days: 730 }
};
const MAX_RANGES = Number(process.env.DESIC_KLINE_SYNC_MAX_RANGES || "120");
const MIN_INTERVAL_MS = Number(process.env.OKX_REST_MIN_INTERVAL_MS || "80");
let lastRequestAt = 0;

function workspaceRoot() {
  return process.cwd();
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

function loadSymbols() {
  const watchlistPath = path.join(workspaceRoot(), "config", "watchlist.local.json");
  if (!fs.existsSync(watchlistPath)) return ["BTC-USDT-SWAP"];
  const parsed = JSON.parse(fs.readFileSync(watchlistPath, "utf8"));
  if (!Array.isArray(parsed.symbols) || parsed.symbols.length === 0) return ["BTC-USDT-SWAP"];
  return Array.from(new Set(parsed.symbols.map((item) => String(item).trim().toUpperCase()).filter(Boolean))).slice(0, 10);
}

function loadProxyConfig() {
  const configPath = path.join(workspaceRoot(), "config", "proxy.local.json");
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.enabled || !config.host || !config.port) return null;
  if (!/^https?$/i.test(config.proxyType || "HTTP")) return null;
  return { host: String(config.host), port: Number(config.port) };
}

function runSql(dbPath, sql) {
  const sqlPath = path.join(workspaceRoot(), "cache", `local-kline-sync-${process.pid}-${Date.now()}.sql`);
  fs.mkdirSync(path.dirname(sqlPath), { recursive: true });
  fs.writeFileSync(sqlPath, sql, "utf8");
  const result = spawnSync("sqlite3", [dbPath, `.read ${sqlPath}`], { encoding: "utf8" });
  fs.rmSync(sqlPath, { force: true });
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed status=${result.status} error=${result.error?.message || ""} stderr=${result.stderr || ""} stdout=${result.stdout || ""}`);
  }
  return result.stdout;
}

function queryJson(dbPath, sql) {
  const result = spawnSync("sqlite3", [dbPath, "-json", sql], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed status=${result.status} error=${result.error?.message || ""} stderr=${result.stderr || ""} stdout=${result.stdout || ""}`);
  }
  return JSON.parse(result.stdout || "[]");
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}

function offsetMs(bar, stepMs) {
  if (bar === "6H" || bar === "12H" || bar === "1D") return (16 * 60 * 60_000) % stepMs;
  return 0;
}

function alignOpen(valueMs, stepMs, offset) {
  return valueMs - (((valueMs - offset) % stepMs) + stepMs) % stepMs;
}

function expectedOpenTimes(startOpen, endOpen, stepMs) {
  const values = [];
  for (let cursor = startOpen; cursor <= endOpen; cursor += stepMs) values.push(cursor);
  return values;
}

function missingRanges(values, stepMs) {
  const ranges = [];
  let start = null;
  let previous = null;
  for (const value of values) {
    if (start === null) {
      start = value;
      previous = value;
      continue;
    }
    if (value === previous + stepMs) {
      previous = value;
      continue;
    }
    ranges.push([start, previous]);
    start = value;
    previous = value;
  }
  if (start !== null) ranges.push([start, previous]);
  return ranges;
}

function findMissing(dbPath, symbol, bar, config, nowMs) {
  const offset = offsetMs(bar, config.stepMs);
  const endOpen = alignOpen(nowMs, config.stepMs, offset) - config.stepMs;
  const startOpen = alignOpen(endOpen - config.days * 86_400_000, config.stepMs, offset);
  const rows = queryJson(
    dbPath,
    `SELECT open_time AS openTime
     FROM candles
     WHERE symbol='${escapeSql(symbol)}'
       AND interval='${escapeSql(bar)}'
       AND open_time BETWEEN ${startOpen} AND ${endOpen}
     ORDER BY open_time ASC;`
  );
  const existing = new Set(rows.map((row) => Number(row.openTime)));
  const missing = expectedOpenTimes(startOpen, endOpen, config.stepMs).filter((value) => !existing.has(value));
  return { startOpen, endOpen, missing, ranges: missingRanges(missing, config.stepMs) };
}

async function throttledFetch(url) {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) await delay(MIN_INTERVAL_MS - elapsed);
  lastRequestAt = Date.now();
  const proxy = process.env.OKX_USE_PROXY === "0" ? null : loadProxyConfig();
  if (proxy) return fetchViaHttpProxy(url, proxy);
  return fetch(url);
}

async function fetchViaHttpProxy(url, proxy) {
  const target = new URL(url);
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const chunks = [];
    let tunnelReady = false;
    let secureSocket = null;
    const fail = (error) => {
      socket.destroy();
      secureSocket?.destroy();
      reject(error);
    };
    socket.setTimeout(15_000, () => fail(new Error(`proxy CONNECT timeout ${proxy.host}:${proxy.port}`)));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      if (tunnelReady) return;
      chunks.push(chunk);
      const head = Buffer.concat(chunks).toString("utf8");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!/^HTTP\/1\.[01] 2\d\d/i.test(head)) {
        fail(new Error(`proxy CONNECT failed: ${head.slice(0, 180).replace(/\s+/g, " ")}`));
        return;
      }
      tunnelReady = true;
      socket.removeAllListeners("data");
      secureSocket = tls.connect({ socket, servername: target.hostname });
      const responseChunks = [];
      secureSocket.setTimeout(20_000, () => fail(new Error(`OKX HTTPS timeout ${target.hostname}`)));
      secureSocket.once("error", fail);
      secureSocket.once("secureConnect", () => {
        secureSocket.write([
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.hostname}`,
          "User-Agent: Desic-Terminal-local-kline-sync/0.1",
          "Accept: application/json",
          "Connection: close",
          "",
          ""
        ].join("\r\n"));
      });
      secureSocket.on("data", (data) => responseChunks.push(data));
      secureSocket.once("end", () => resolve(Buffer.concat(responseChunks)));
    });
  });
  const text = raw.toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  if (split < 0) throw new Error(`invalid HTTP response from OKX: ${text.slice(0, 180)}`);
  const head = text.slice(0, split);
  const body = decodeHttpBody(head, raw.subarray(split + 4));
  const status = Number(head.match(/^HTTP\/1\.[01]\s+(\d+)/i)?.[1] || 0);
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function decodeHttpBody(head, bodyBytes) {
  let bytes = bodyBytes;
  if (/transfer-encoding:\s*chunked/i.test(head)) bytes = decodeChunkedBody(bodyBytes);
  if (/content-encoding:\s*gzip/i.test(head)) bytes = zlib.gunzipSync(bytes);
  else if (/content-encoding:\s*br/i.test(head)) bytes = zlib.brotliDecompressSync(bytes);
  else if (/content-encoding:\s*deflate/i.test(head)) bytes = zlib.inflateSync(bytes);
  return bytes.toString("utf8");
}

function decodeChunkedBody(buffer) {
  let offset = 0;
  const chunks = [];
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset, "utf8");
    if (lineEnd < 0) break;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("ascii").split(";")[0].trim(), 16);
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

async function fetchHistoryCandles(symbol, bar, fromOpen, toOpen, stepMs) {
  const rows = new Map();
  let after = toOpen + stepMs;
  for (let page = 0; page < 160; page += 1) {
    const url = `${REST_BASE}/api/v5/market/history-candles?instId=${encodeURIComponent(symbol)}&bar=${encodeURIComponent(bar)}&after=${after}&limit=300`;
    const response = await throttledFetch(url);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
    const json = JSON.parse(text);
    if (json.code !== "0") throw new Error(`OKX ${json.code}: ${json.msg}`);
    if (!Array.isArray(json.data) || json.data.length === 0) break;
    let oldest = after;
    for (const row of json.data) {
      const openTime = Number(row[0]);
      oldest = Math.min(oldest, openTime);
      if (openTime >= fromOpen && openTime <= toOpen) rows.set(openTime, row);
    }
    after = oldest;
    if (oldest < fromOpen) break;
  }
  return Array.from(rows.values()).sort((a, b) => Number(a[0]) - Number(b[0]));
}

function validateRow(row, bar, stepMs) {
  const ts = Number(row[0]);
  const offset = offsetMs(bar, stepMs);
  if ((ts - offset) % stepMs !== 0) throw new Error(`${bar} open_time not aligned: ${ts}`);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  if (high < low || high < open || high < close || low > open || low > close) throw new Error(`${bar} invalid OHLC at ${ts}`);
  if (!Number.isFinite(volume) || volume < 0) throw new Error(`${bar} invalid volume at ${ts}`);
}

function upsertRows(dbPath, symbol, bar, rows) {
  if (rows.length === 0) return 0;
  const now = Date.now();
  const statements = rows.map((row) => {
    const openTime = Number(row[0]);
    return `INSERT INTO candles (symbol, interval, open_time, close_time, open, high, low, close, volume, volume_ccy, volume_quote, confirm, source, updated_at)
VALUES ('${escapeSql(symbol)}','${escapeSql(bar)}',${openTime},${openTime},'${escapeSql(row[1])}','${escapeSql(row[2])}','${escapeSql(row[3])}','${escapeSql(row[4])}','${escapeSql(row[5])}','${escapeSql(row[6] || "")}','${escapeSql(row[7] || "")}',${row[8] === "1" ? 1 : 0},'smoke-history',${now})
ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
  open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
  volume=excluded.volume, volume_ccy=excluded.volume_ccy, volume_quote=excluded.volume_quote,
  confirm=excluded.confirm, source=excluded.source, updated_at=excluded.updated_at;`;
  });
  runSql(dbPath, `BEGIN;\n${statements.join("\n")}\nCOMMIT;`);
  return rows.length;
}

async function main() {
  const dbPath = sqlitePath();
  const symbols = loadSymbols();
  const nowMs = Date.now();
  const results = [];
  let syncedRanges = 0;
  for (const symbol of symbols) {
    for (const [bar, config] of Object.entries(REQUIRED_BARS)) {
      const audit = findMissing(dbPath, symbol, bar, config, nowMs);
      let fetched = 0;
      let upserted = 0;
      for (const [from, to] of audit.ranges) {
        if (syncedRanges >= MAX_RANGES) throw new Error(`range safety limit exceeded: ${MAX_RANGES}`);
        syncedRanges += 1;
        const rows = await fetchHistoryCandles(symbol, bar, from, to, config.stepMs);
        for (const row of rows) validateRow(row, bar, config.stepMs);
        fetched += rows.length;
        upserted += upsertRows(dbPath, symbol, bar, rows);
      }
      results.push({ symbol, bar, missingBefore: audit.missing.length, ranges: audit.ranges.length, fetched, upserted });
    }
  }
  process.stdout.write(`[smoke] local kline sync ok: db=${dbPath} symbols=${symbols.length} checks=${results.length} ${JSON.stringify(results)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[smoke] local kline sync failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
