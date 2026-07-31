import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { assertAiSmokeConfig, loadAiSmokeConfig } from "./load-ai-smoke-config.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sidecarPath = fileURLToPath(new URL("./cline-sidecar.mjs", import.meta.url));
const config = await loadAiSmokeConfig();
assertAiSmokeConfig(config);

function startSidecar(label) {
  const child = spawn(process.execPath, [sidecarPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const events = [];
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      process.stdout.write(`[${label}] ${JSON.stringify(event)}\n`);
    } catch {
      process.stderr.write(`[${label}:raw] ${line}\n`);
    }
  });
  readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
    process.stderr.write(`[${label}:stderr] ${line}\n`);
  });
  return { child, events, label };
}

function write(sidecar, payload) {
  sidecar.child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function waitFor(sidecar, predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = sidecar.events.find(predicate);
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
  const first = startSidecar("first");
  await waitFor(first, (event) => event.type === "status" && event.sessionId === "system", 15_000, "first ready");
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));

  const second = startSidecar("second");
  const sessionId = `smoke-restart-${Date.now()}`;
  await waitFor(second, (event) => event.type === "status" && event.sessionId === "system", 15_000, "second ready");
  write(second, {
    type: "sendMessage",
    sessionId,
    config,
    messages: [{ id: "u1", role: "user", content: "用一句中文回复：重启恢复正常。" }]
  });
  await waitFor(second, (event) => event.sessionId === sessionId && event.type === "status", 15_000, "second session status");
  write(second, { type: "stop", sessionId });
  await waitFor(
    second,
    (event) => event.sessionId === sessionId && event.type === "done" && event.finishReason === "cancelled",
    20_000,
    "second cancelled done"
  );
  write(second, { type: "shutdown" });
  second.child.stdin.end();
  second.child.kill();
  process.stdout.write("[smoke] sidecar restart ok\n");
} catch (error) {
  process.stderr.write(`[smoke] sidecar restart failed: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
