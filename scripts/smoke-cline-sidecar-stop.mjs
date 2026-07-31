import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { assertAiSmokeConfig, loadAiSmokeConfig } from "./load-ai-smoke-config.mjs";

const config = await loadAiSmokeConfig();
assertAiSmokeConfig(config);
const child = spawn(process.execPath, [fileURLToPath(new URL("./cline-sidecar.mjs", import.meta.url))], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: ["pipe", "pipe", "pipe"]
});

const sessionId = `smoke-stop-${Date.now()}`;
const events = [];
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

stderr.on("line", (line) => {
  process.stderr.write(`[sidecar] ${line}\n`);
});

rl.on("line", (line) => {
  try {
    const event = JSON.parse(line);
    events.push(event);
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } catch {
    process.stderr.write(`[sidecar:raw] ${line}\n`);
  }
});

function write(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = events.find(predicate);
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
  write({
    type: "sendMessage",
    sessionId,
    config,
    messages: [{ id: "u1", role: "user", content: "用中文持续输出一段较长的风险提示，直到被停止。" }]
  });
  await waitFor((event) => event.sessionId === sessionId && event.type === "status", 15_000, "session status");
  write({ type: "stop", sessionId });
  await waitFor(
    (event) => event.sessionId === sessionId && event.type === "done" && event.finishReason === "cancelled",
    20_000,
    "cancelled done"
  );
  write({ type: "shutdown", sessionId });
  child.stdin.end();
  child.kill();
  process.stdout.write(`[smoke] sidecar stop ok: ${sessionId}\n`);
} catch (error) {
  child.kill();
  process.stderr.write(`[smoke] sidecar stop failed: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
