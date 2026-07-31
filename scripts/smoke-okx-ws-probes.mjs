import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

const probes = [
  {
    label: "public",
    url: "wss://ws.okx.com:8443/ws/v5/public",
    arg: { channel: "tickers", instId: "BTC-USDT-SWAP" },
    expectedChannel: "tickers"
  },
  {
    label: "business",
    url: "wss://ws.okx.com:8443/ws/v5/business",
    arg: { channel: "candle1m", instId: "BTC-USDT-SWAP" },
    expectedChannel: "candle1m"
  },
  {
    label: "books",
    url: "wss://ws.okx.com:8443/ws/v5/public",
    arg: { channel: "books", instId: "BTC-USDT-SWAP" },
    expectedChannel: "books"
  },
  {
    label: "trades",
    url: "wss://ws.okx.com:8443/ws/v5/public",
    arg: { channel: "trades", instId: "BTC-USDT-SWAP" },
    expectedChannel: "trades"
  }
];

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
    const frameStart = offset;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    offset += 2;
    if (length === 126) {
      if (offset + 2 > buffer.length) {
        offset = frameStart;
        break;
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) {
        offset = frameStart;
        break;
      }
      const largeLength = buffer.readBigUInt64BE(offset);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket frame too large");
      length = Number(largeLength);
      offset += 8;
    }
    const masked = Boolean(second & 0x80);
    let mask;
    if (masked) {
      if (offset + 4 > buffer.length) {
        offset = frameStart;
        break;
      }
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.length) {
      offset = frameStart;
      break;
    }
    let payload = buffer.subarray(offset, offset + length);
    offset += length;
    if (masked && mask) {
      payload = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]));
    }
    if (opcode === 1) messages.push(payload.toString("utf8"));
    if (opcode === 8) return { messages, remaining: Buffer.alloc(0) };
  }
  return { messages, remaining: buffer.subarray(offset) };
}

async function probeWs(probe) {
  const started = Date.now();
  const target = new URL(probe.url);
  const rawSocket = await connectTunnel(target);
  const socket = tls.connect({ socket: rawSocket, servername: target.hostname });
  const key = crypto.randomBytes(16).toString("base64");
  await new Promise((resolve, reject) => {
    socket.setTimeout(15_000, () => reject(new Error(`${probe.label} websocket timeout`)));
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
          "User-Agent: Desic-Terminal-ws-smoke/0.1",
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
        reject(new Error(`${probe.label} websocket handshake failed: ${text.slice(0, 180).replace(/\s+/g, " ")}`));
        return;
      }
      resolve();
    });
  });

  socket.write(encodeFrame(JSON.stringify({ op: "subscribe", args: [probe.arg] })));
  let pending = Buffer.alloc(0);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${probe.label} websocket subscribe timeout`)), 15_000);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const decoded = tryDecodeFrames(pending);
      pending = decoded.remaining;
      for (const message of decoded.messages) {
        const data = JSON.parse(message);
        if (data.event === "error") {
          clearTimeout(timer);
          reject(new Error(`${probe.label} subscription rejected: ${message.slice(0, 240)}`));
          return;
        }
        if (data.arg?.channel === probe.expectedChannel && Array.isArray(data.data) && data.data.length > 0) {
          const timestamps = data.data
            .map((item) => Number(item?.ts))
            .filter(Number.isFinite);
          clearTimeout(timer);
          resolve({
            label: probe.label,
            latencyMs: Date.now() - started,
            eventDelayMs: timestamps.length > 0 ? Math.max(0, Date.now() - Math.max(...timestamps)) : null,
            channel: data.arg.channel
          });
          return;
        }
      }
    });
    socket.once("error", reject);
  });
  socket.end();
  return result;
}

async function main() {
  const results = [];
  for (const probe of probes) {
    results.push(await probeWs(probe));
  }
  process.stdout.write(`[smoke] okx ws probes ok: ${JSON.stringify(results)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[smoke] okx ws probes failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
