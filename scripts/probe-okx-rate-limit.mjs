// Probes OKX's REST rate limiter through the configured proxy so the app's
// private-REST pacing can be calibrated against real behaviour instead of a
// documented number alone.
//
// Usage: node scripts/probe-okx-rate-limit.mjs [--proxy http://127.0.0.1:7890]
//
// Only public, unauthenticated endpoints are used, so this needs no API key and
// never touches account or order state.

const args = process.argv.slice(2);
const proxyFlagIndex = args.indexOf("--proxy");
const PROXY = proxyFlagIndex >= 0 ? args[proxyFlagIndex + 1] : process.env.DESIC_PROBE_PROXY ?? "http://127.0.0.1:7890";
const BASE = "https://www.okx.com";

// Node's fetch only honours HTTPS_PROXY when NODE_USE_ENV_PROXY is set, and the
// dispatcher is created before this file runs, so re-exec once with it set.
if (process.env.NODE_USE_ENV_PROXY !== "1") {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname, ...args], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY }
  });
  process.exit(result.status ?? 1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function okxGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    const body = await response.text();
    let code = "";
    let msg = "";
    try {
      const parsed = JSON.parse(body);
      code = String(parsed?.code ?? "");
      msg = String(parsed?.msg ?? "");
    } catch {
      msg = body.slice(0, 80);
    }
    return {
      status: response.status,
      code,
      msg,
      retryAfter: response.headers.get("retry-after"),
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return { status: 0, code: "network", msg: String(error?.message ?? error), retryAfter: null, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function classify(result) {
  if (result.status === 429) return "HTTP429";
  if (result.code === "50011") return "50011";
  if (result.status >= 500) return `HTTP${result.status}`;
  if (result.status !== 200 || (result.code !== "" && result.code !== "0")) return `other(${result.status}/${result.code})`;
  return "ok";
}

/**
 * Fires `count` requests at `path`, either as fast as possible or paced at
 * `intervalMs`, and reports how OKX responded.
 */
async function burst(label, path, count, intervalMs) {
  const results = [];
  const startedAt = Date.now();
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && intervalMs > 0) await sleep(intervalMs);
    results.push(await okxGet(path));
  }
  const totalMs = Date.now() - startedAt;
  const tally = new Map();
  for (const result of results) {
    const key = classify(result);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const firstFailure = results.find((result) => classify(result) !== "ok");
  console.log(
    `${label.padEnd(34)} n=${String(count).padStart(3)} interval=${String(intervalMs).padStart(4)}ms ` +
      `total=${String(totalMs).padStart(6)}ms  ` +
      `=> ${[...tally.entries()].map(([key, value]) => `${key}×${value}`).join(", ")}` +
      (firstFailure ? `  first-failure(status=${firstFailure.status}, code=${firstFailure.code}, retry-after=${firstFailure.retryAfter ?? "-"}, msg="${firstFailure.msg.slice(0, 60)}")` : "")
  );
  return results;
}

const MARKET_TICKER = "/api/v5/market/ticker?instId=BTC-USDT-SWAP";

/**
 * Hammers one endpoint for `seconds` with no pacing and reports how OKX answers
 * once the window is exceeded: HTTP status, OKX code, and any Retry-After.
 */
async function sustained(label, path, seconds) {
  const deadline = Date.now() + seconds * 1_000;
  const tally = new Map();
  const failures = [];
  let requests = 0;
  while (Date.now() < deadline) {
    const result = await okxGet(path);
    requests += 1;
    const key = classify(result);
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (key !== "ok" && failures.length < 4) {
      failures.push(result);
    }
  }
  const windowSeconds = Math.max(1, Math.round(seconds));
  console.log(
    `${label.padEnd(34)} requests=${String(requests).padStart(4)} in ${windowSeconds}s ` +
      `(~${(requests / windowSeconds).toFixed(1)}/s) => ${[...tally.entries()].map(([key, value]) => `${key}×${value}`).join(", ")}`
  );
  for (const failure of failures) {
    console.log(
      `    failure: status=${failure.status} code=${failure.code} retry-after=${failure.retryAfter ?? "-"} msg="${failure.msg.slice(0, 70)}"`
    );
  }
  return { requests, tally, failures };
}

console.log(`OKX rate-limit probe via ${PROXY}\n`);
console.log("-- connectivity --");
const reachability = await okxGet("/api/v5/public/time");
console.log(`GET /api/v5/public/time => status=${reachability.status} code=${reachability.code} ${reachability.elapsedMs}ms`);

console.log("\n-- sustained load: does OKX answer with 429, 50011, or a Retry-After header? --");
const sustainedRun = await sustained("sustained 20s unpaced", MARKET_TICKER, 20);
if (sustainedRun.failures.length === 0) {
  console.log(
    "    No throttling observed from this IP. Public per-IP budgets are shared with the proxy, " +
      "so this cannot confirm the private per-User-ID budget; treat the documented archive limit as the source of truth."
  );
}

console.log("\n-- recovery: how long until the same endpoint answers again --");
for (let round = 1; round <= 3; round += 1) {
  await sleep(1_000);
  const probe = await okxGet(MARKET_TICKER);
  console.log(`    +${round}s after load: ${classify(probe)}`);
  if (classify(probe) === "ok") break;
}

console.log("\n-- paced control: the interval the archive endpoints need (5 req / 2s) --");
await burst("paced 400ms", MARKET_TICKER, 15, 400);

console.log("\nReport: HTTP429/50011 counts show how OKX answers; retry-after is printed when present.");
