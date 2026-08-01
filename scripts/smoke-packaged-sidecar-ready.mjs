import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarRoot = path.join(root, "src-tauri", "resources", "ai-sidecar");
const manifest = JSON.parse(await readFile(path.join(sidecarRoot, "manifest.json"), "utf8"));
const nodeName = manifest.platform === "win32" ? "node.exe" : "node";
const nodePath = path.join(sidecarRoot, "runtime", nodeName);
const workDir = await mkdtemp(path.join(os.tmpdir(), "desic terminal sidecar smoke "));
const events = [];
let stderr = "";
let child;

function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 50);
  });
}

function waitForExit(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for packaged sidecar exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

try {
  await access(nodePath);
  await access(path.join(sidecarRoot, "sidecar.mjs"));
  child = spawn(nodePath, ["--", "sidecar.mjs"], {
    cwd: sidecarRoot,
    env: {
      ...process.env,
      DESIC_AI_EVENT_DEBUG: "0",
      DESIC_SIDECAR_WORK_DIR: workDir
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      stderr += `${line}\n`;
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await waitFor(
    (event) => event.type === "status" && event.sessionId === "system" && event.status === "ready",
    15_000,
    "packaged sidecar ready"
  );
  await waitFor(
    (event) => event.type === "status" && event.sessionId === "system" && event.status === "core-ready",
    30_000,
    "packaged ClineCore ready"
  );
  child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
  child.stdin.end();
  const exitCode = await waitForExit(10_000);
  if (exitCode !== 0) throw new Error(`packaged sidecar exited with code ${exitCode}`);
  process.stdout.write(`[smoke] packaged sidecar ${manifest.platform}-${manifest.arch} ready\n`);
} catch (error) {
  child?.kill();
  process.stderr.write(`[smoke] packaged sidecar failed: ${error?.message || String(error)}\n${stderr.slice(-4_000)}`);
  process.exitCode = 1;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
