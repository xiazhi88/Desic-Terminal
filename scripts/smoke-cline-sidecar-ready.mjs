import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = fileURLToPath(new URL("..", import.meta.url));
const sidecarPath = fileURLToPath(new URL("./cline-sidecar.mjs", import.meta.url));
const child = spawn(process.execPath, [sidecarPath], {
  cwd: root,
  env: { ...process.env, DESIC_AI_EVENT_DEBUG: "0" },
  stdio: ["pipe", "pipe", "pipe"]
});
const events = [];

readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  try {
    events.push(JSON.parse(line));
  } catch {
    process.stderr.write(`[sidecar:raw] ${line}\n`);
  }
});
readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
  process.stderr.write(`[sidecar:stderr] ${line}\n`);
});

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
    }, 50);
  });
}

function waitForExit(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for sidecar exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

try {
  await waitFor(
    (event) => event.type === "status" && event.sessionId === "system" && event.status === "ready",
    15_000,
    "sidecar ready"
  );
  const invalidSessionId = `background:smoke-invalid-${Date.now()}`;
  child.stdin.write(`${JSON.stringify({ type: "sendMessage", sessionId: invalidSessionId, messages: [] })}\n`);
  await waitFor(
    (event) => event.type === "error" && event.sessionId === invalidSessionId && /missing user prompt/i.test(event.message || ""),
    5_000,
    "handled command rejection"
  );
  if (child.exitCode !== null) throw new Error(`sidecar died after handled command rejection: ${child.exitCode}`);
  child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
  child.stdin.end();
  const exitCode = await waitForExit(10_000);
  if (exitCode !== 0) throw new Error(`sidecar exited with code ${exitCode}`);
  process.stdout.write("[smoke] sidecar ready/rejection/shutdown ok\n");
} catch (error) {
  child.kill();
  process.stderr.write(`[smoke] sidecar ready/shutdown failed: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
