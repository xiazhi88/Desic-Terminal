import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const devUrl = "http://127.0.0.1:1420/";
const runId = `${Date.now()}-${process.pid}`;
const stdoutLog = path.join(workspaceRoot, `vite-dev.${runId}.stdout.log`);
const stderrLog = path.join(workspaceRoot, `vite-dev.${runId}.stderr.log`);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function tailLog(filePath, maxChars = 2000) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.slice(-maxChars);
  } catch {
    return "";
  }
}

function startWindowsDevServer() {
  const stdout = fs.openSync(stdoutLog, "a");
  const stderr = fs.openSync(stderrLog, "a");
  const child = spawn("cmd.exe", ["/d", "/s", "/c", "npm.cmd run dev"], {
    cwd: workspaceRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr]
  });
  child.unref();
}

async function main() {
  if (await requestOk(devUrl)) {
    process.stdout.write(`[dev] frontend already ready: ${devUrl}\n`);
    return;
  }

  if (process.platform === "win32") {
    startWindowsDevServer();
  } else {
    spawn("npm", ["run", "dev"], {
      cwd: workspaceRoot,
      detached: true,
      stdio: "ignore"
    }).unref();
  }

  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (await requestOk(devUrl)) {
      process.stdout.write(`[dev] frontend ready: ${devUrl}\n`);
      return;
    }
    await wait(1000);
  }
  const stdoutTail = tailLog(stdoutLog);
  const stderrTail = tailLog(stderrLog);
  throw new Error(
    `frontend dev server did not become ready within 180s: ${devUrl}\nstdout tail:\n${stdoutTail || "[empty]"}\nstderr tail:\n${stderrTail || "[empty]"}`
  );
}

main().catch((error) => {
  process.stderr.write(`[dev] start-dev-ready failed: ${error?.message || String(error)}\n`);
  process.exit(1);
});
