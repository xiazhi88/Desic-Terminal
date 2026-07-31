import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import zlib from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

const REST_BASE = "https://openapi.okx.com";
const DEFAULT_SYMBOL = process.env.OKX_SYMBOL || "BTC-USDT-SWAP";
const DEFAULT_BARS = (process.env.OKX_BARS || "5m,30m,1H,2H,4H,12H").split(",").map((item) => item.trim()).filter(Boolean);
const LIMIT = Number(process.env.OKX_KLINE_LIMIT || "300");
const MIN_INTERVAL_MS = Number(process.env.OKX_REST_MIN_INTERVAL_MS || "80");
const SYMBOL_LIMIT = Number(process.env.OKX_KLINE_SYMBOL_LIMIT || "10");

let lastRequestAt = 0;

function loadProxyConfig() {
  const configPath = path.resolve("config/proxy.local.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config.enabled || !config.host || !config.port) return null;
    if (!/^https?$/i.test(config.proxyType || "HTTP")) return null;
    return {
      protocol: String(config.proxyType || "HTTP").toLowerCase(),
      host: String(config.host),
      port: Number(config.port)
    };
  } catch {
    return null;
  }
}

function loadSymbols() {
  if (process.env.OKX_SYMBOLS) {
    return normalizeSymbols(process.env.OKX_SYMBOLS.split(","));
  }
  if (process.env.OKX_SYMBOL) return normalizeSymbols([DEFAULT_SYMBOL]);
  const watchlistPath = path.resolve("config/watchlist.local.json");
  if (fs.existsSync(watchlistPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(watchlistPath, "utf8"));
      if (Array.isArray(parsed.symbols) && parsed.symbols.length > 0) {
        return normalizeSymbols(parsed.symbols);
      }
    } catch (error) {
      process.stderr.write(`[smoke] failed to load watchlist.local.json: ${error?.message || String(error)}\n`);
    }
  }
  return normalizeSymbols([DEFAULT_SYMBOL]);
}

function normalizeSymbols(symbols) {
  return Array.from(
    new Set(
      symbols
        .map((item) => String(item || "").trim().toUpperCase())
        .filter(Boolean)
        .map((item) => (item.includes("-") ? item : `${item}-USDT-SWAP`))
    )
  ).slice(0, SYMBOL_LIMIT);
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
  if (target.protocol !== "https:") throw new Error(`proxy smoke only supports https URL: ${url}`);
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
      socket.write(
        `CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\nProxy-Connection: Keep-Alive\r\n\r\n`
      );
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
        secureSocket.write(
          [
            `GET ${target.pathname}${target.search} HTTP/1.1`,
            `Host: ${target.hostname}`,
            "User-Agent: Desic-Terminal-smoke/0.1",
            "Accept: application/json",
            "Connection: close",
            "",
            ""
          ].join("\r\n")
        );
      });
      secureSocket.on("data", (data) => responseChunks.push(data));
      secureSocket.once("end", () => resolve(Buffer.concat(responseChunks)));
    });
  });
  const text = raw.toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  if (split < 0) throw new Error(`invalid HTTP response from OKX: ${text.slice(0, 180)}`);
  const head = text.slice(0, split);
  const bodyBytes = raw.subarray(split + 4);
  const status = Number(head.match(/^HTTP\/1\.[01]\s+(\d+)/i)?.[1] || 0);
  const body = decodeHttpBody(head, bodyBytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  };
}

function decodeHttpBody(head, bodyBytes) {
  let bytes = bodyBytes;
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    bytes = decodeChunkedBody(bodyBytes);
  }
  if (/content-encoding:\s*gzip/i.test(head)) {
    bytes = zlib.gunzipSync(bytes);
  } else if (/content-encoding:\s*br/i.test(head)) {
    bytes = zlib.brotliDecompressSync(bytes);
  } else if (/content-encoding:\s*deflate/i.test(head)) {
    bytes = zlib.inflateSync(bytes);
  }
  return bytes.toString("utf8");
}

function decodeChunkedBody(buffer) {
  let offset = 0;
  const chunks = [];
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset, "utf8");
    if (lineEnd < 0) break;
    const sizeText = buffer.subarray(offset, lineEnd).toString("ascii").split(";")[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) throw new Error(`invalid chunk size: ${sizeText}`);
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function barMs(bar) {
  const map = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1H": 3_600_000,
    "2H": 7_200_000,
    "4H": 14_400_000,
    "6H": 21_600_000,
    "12H": 43_200_000,
    "1D": 86_400_000
  };
  return map[bar];
}

function normalize(row) {
  return {
    ts: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    confirm: row[8] === "1"
  };
}

async function fetchCandles(symbol, bar) {
  const url = `${REST_BASE}/api/v5/market/history-candles?instId=${encodeURIComponent(symbol)}&bar=${encodeURIComponent(bar)}&limit=${LIMIT}`;
  const response = await throttledFetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  const json = JSON.parse(text);
  if (json.code !== "0") throw new Error(`OKX ${json.code}: ${json.msg}`);
  return json.data.map(normalize).sort((a, b) => a.ts - b.ts);
}

function validate(candles, bar) {
  const step = barMs(bar);
  if (!step) throw new Error(`unsupported bar ${bar}`);
  if (candles.length < Math.min(50, LIMIT)) throw new Error(`${bar} returned too few candles: ${candles.length}`);
  const errors = [];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!Number.isFinite(candle.ts) || candle.ts <= 0) errors.push(`${bar} invalid ts at ${index}`);
    if (candle.high < candle.low || candle.high < candle.open || candle.high < candle.close) errors.push(`${bar} invalid high at ${candle.ts}`);
    if (candle.low > candle.open || candle.low > candle.close) errors.push(`${bar} invalid low at ${candle.ts}`);
    if (!Number.isFinite(candle.volume) || candle.volume < 0) errors.push(`${bar} invalid volume at ${candle.ts}`);
    if (index > 0) {
      const delta = candle.ts - candles[index - 1].ts;
      if (delta !== step) errors.push(`${bar} gap ${delta}ms between ${candles[index - 1].ts} and ${candle.ts}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.slice(0, 8).join("; "));
  return {
    count: candles.length,
    first: candles[0].ts,
    last: candles[candles.length - 1].ts
  };
}

async function main() {
  const results = [];
  const symbols = loadSymbols();
  for (const symbol of symbols) {
    for (const bar of DEFAULT_BARS) {
      const candles = await fetchCandles(symbol, bar);
      results.push({ symbol, bar, ...validate(candles, bar) });
    }
  }
  process.stdout.write(
    `[smoke] okx kline continuity ok: symbols=${symbols.length}, bars=${DEFAULT_BARS.length}, checks=${results.length} ${JSON.stringify(results)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`[smoke] okx kline continuity failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
