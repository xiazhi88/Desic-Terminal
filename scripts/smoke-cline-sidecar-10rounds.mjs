import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { assertAiSmokeConfig, loadAiSmokeConfig } from "./load-ai-smoke-config.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sidecarPath = fileURLToPath(new URL("./cline-sidecar.mjs", import.meta.url));
const config = await loadAiSmokeConfig();
assertAiSmokeConfig(config);
const child = spawn(process.execPath, [sidecarPath], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"]
});

const events = [];
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  try {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === "status" || event.type === "done" || event.type === "error") {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  } catch {
    process.stderr.write(`[sidecar:raw] ${line}\n`);
  }
});
readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
  process.stderr.write(`[sidecar] ${line}\n`);
});

function write(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function waitFor(predicate, timeoutMs, label, startIndex = 0) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = events.slice(startIndex).find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 100);
  });
}

try {
  await waitFor((event) => event.type === "status" && event.sessionId === "system", 15_000, "system ready");
  const sessionId = `smoke-10rounds-${Date.now()}`;
  const history = [];
  for (let round = 1; round <= 10; round += 1) {
    const eventStart = events.length;
    history.push({ id: `u${round}`, role: "user", content: `第 ${round} 轮：用中文只回复“第${round}轮正常”。` });
    write({ type: "sendMessage", sessionId, config, messages: history });
    const done = await waitFor(
      (event) => event.sessionId === sessionId && event.type === "done",
      45_000,
      `round ${round} done`,
      eventStart
    );
    if (done.finishReason === "cancelled") {
      throw new Error(`round ${round} was cancelled unexpectedly`);
    }
    if (done.finishReason === "error") {
      const errorEvent = events
        .slice(eventStart)
        .find((event) => event.sessionId === sessionId && event.type === "error");
      const text = events
        .slice(eventStart)
        .filter((event) => event.sessionId === sessionId && event.type === "delta" && event.channel === "text")
        .map((event) => event.content)
        .join("");
      throw new Error(`round ${round} failed: ${errorEvent?.message || text || "unknown sidecar error"}`);
    }
    const text = events
      .slice(eventStart)
      .filter((event) => event.sessionId === sessionId && event.type === "delta" && event.channel === "text")
      .map((event) => event.content)
      .join("");
    if (!text.trim()) {
      throw new Error(`round ${round} completed without assistant text`);
    }
    const expected = `第${round}轮正常`;
    if (!text.includes(expected)) {
      throw new Error(`round ${round} missing expected text: expected=${expected}, actual=${text}`);
    }
    if ((text.match(new RegExp(expected, "g")) || []).length > 1 || /第第|轮轮|正常正常/.test(text)) {
      throw new Error(`round ${round} appears duplicated: ${text}`);
    }
    history.push({ id: `a${round}`, role: "assistant", content: text || `第${round}轮正常` });
    process.stdout.write(`[round] ${round}/10 done text=${text.slice(0, 32)}\n`);
  }
  write({ type: "shutdown" });
  child.stdin.end();
  child.kill();
  process.stdout.write("[smoke] sidecar 10 rounds ok\n");
} catch (error) {
  child.kill();
  process.stderr.write(`[smoke] sidecar 10 rounds failed: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
