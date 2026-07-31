import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

const wsUrl = "wss://ws.okx.com:8443/ws/v5/public";
const fallbackSymbols = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "BNB-USDT-SWAP", "XRP-USDT-SWAP"];
const symbols = loadSymbols();

function loadSymbols() {
  const envSymbols = process.env.OKX_SMOKE_SYMBOLS?.split(/[,\s]+/).map((item) => item.trim().toUpperCase()).filter(Boolean);
  if (envSymbols?.length) return Array.from(new Set(envSymbols)).slice(0, 10);
  const watchlistPath = path.resolve("config/watchlist.local.json");
  if (fs.existsSync(watchlistPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(watchlistPath, "utf8"));
      const configured = Array.isArray(parsed.symbols) ? parsed.symbols : [];
      const normalized = configured
        .map((item) => String(item || "").trim().toUpperCase())
        .filter((item) => /^[A-Z0-9]+-USDT-SWAP$/.test(item));
      if (normalized.length) return Array.from(new Set(normalized)).slice(0, 10);
    } catch {
      // Fall through to stable defaults.
    }
  }
  return fallbackSymbols;
}

function loadProxyConfig() {
  const configPath = path.resolve("config/proxy.local.json");
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.enabled || !config.host || !config.port) return null;
  return { host: String(config.host), port: Number(config.port) };
}

async function connectTunnel(target) {
  const proxy = process.env.OKX_USE_PROXY === "0" ? null : loadProxyConfig();
  if (!proxy) return net.connect({ host: target.hostname, port: Number(target.port || 443) });
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const chunks = [];
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(15_000, () => fail(new Error(`proxy CONNECT timeout ${proxy.host}:${proxy.port}`)));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}:${target.port || 443}\r\nProxy-Connection: Keep-Alive\r\n\r\n`
      );
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const head = Buffer.concat(chunks).toString("utf8");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      if (!/^HTTP\/1\.[01] 2\d\d/i.test(head)) {
        fail(new Error(`proxy CONNECT failed: ${head.slice(0, 180).replace(/\s+/g, " ")}`));
        return;
      }
      resolve(socket);
    });
  });
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    throw new Error("payload too large");
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function tryDecodeFrames(buffer) {
  let offset = 0;
  const messages = [];
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    offset += 2;
    if (length === 126) {
      if (offset + 2 > buffer.length) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      throw new Error("large websocket frame unsupported in smoke");
    }
    const masked = Boolean(second & 0x80);
    let mask;
    if (masked) {
      if (offset + 4 > buffer.length) break;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.length) break;
    let payload = buffer.subarray(offset, offset + length);
    offset += length;
    if (masked && mask) {
      payload = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]));
    }
    if (opcode === 1) messages.push(payload.toString("utf8"));
    if (opcode === 8) throw new Error("websocket closed by server");
  }
  return { messages, remaining: buffer.subarray(offset) };
}

async function connectWebSocket(url) {
  const target = new URL(url);
  const rawSocket = await connectTunnel(target);
  const socket = tls.connect({ socket: rawSocket, servername: target.hostname });
  const key = crypto.randomBytes(16).toString("base64");
  await new Promise((resolve, reject) => {
    socket.setTimeout(15_000, () => reject(new Error("public websocket handshake timeout")));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      socket.write(
        [
          `GET ${target.pathname} HTTP/1.1`,
          `Host: ${target.hostname}:${target.port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "User-Agent: Desic-Terminal-multi-ticker-smoke/0.1",
          "",
          ""
        ].join("\r\n")
      );
    });
    const chunks = [];
    socket.on("data", function onHandshake(chunk) {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      if (split < 0) return;
      socket.off("data", onHandshake);
      if (!/^HTTP\/1\.[01] 101/i.test(text)) {
        reject(new Error(`public websocket handshake failed: ${text.slice(0, 180).replace(/\s+/g, " ")}`));
        return;
      }
      resolve();
    });
  });
  return socket;
}

async function main() {
  if (symbols.length < 2) {
    throw new Error(`multi ticker smoke requires at least 2 symbols, got ${symbols.length}`);
  }
  const started = Date.now();
  const socket = await connectWebSocket(wsUrl);
  const args = symbols.map((instId) => ({ channel: "tickers", instId }));
  socket.write(encodeFrame(JSON.stringify({ op: "subscribe", args })));
  let pending = Buffer.alloc(0);
  const received = new Map();
  const subscribed = new Set();
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ticker data timeout: received=${JSON.stringify([...received.keys()])} subscribed=${JSON.stringify([...subscribed])}`));
    }, 25_000);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const decoded = tryDecodeFrames(pending);
      pending = decoded.remaining;
      for (const message of decoded.messages) {
        const frame = JSON.parse(message);
        if (frame.event === "error") {
          clearTimeout(timer);
          reject(new Error(`multi ticker subscription rejected: ${message.slice(0, 240)}`));
          return;
        }
        if (frame.event === "subscribe" && frame.arg?.channel === "tickers" && frame.arg?.instId) {
          subscribed.add(frame.arg.instId);
        }
        if (frame.arg?.channel === "tickers" && Array.isArray(frame.data)) {
          for (const item of frame.data) {
            if (!symbols.includes(item.instId)) continue;
            if (Number(item.ts) > 0 && item.last && item.instId) {
              received.set(item.instId, { last: item.last, ts: item.ts });
            }
          }
        }
        if (received.size === symbols.length) {
          clearTimeout(timer);
          resolve({
            latencyMs: Date.now() - started,
            symbols: symbols.map((symbol) => ({ symbol, ...received.get(symbol) }))
          });
          return;
        }
      }
    });
    socket.once("error", reject);
  });
  socket.end();
  process.stdout.write(`[smoke] okx multi ticker ok: ${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[smoke] okx multi ticker failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
