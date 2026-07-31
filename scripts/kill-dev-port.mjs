import { execFileSync } from "node:child_process";

const port = Number(process.env.DESIC_DEV_PORT || 1420);
const workspace = process.cwd().toLowerCase();

function ps(command) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function taskkill(pid) {
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

function execText(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function unixPortPids() {
  return execText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function unixCommandLine(pid) {
  return execText("ps", ["-p", String(pid), "-o", "command="]);
}

function unixKill(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

const pids = process.platform === "win32"
  ? Array.from(new Set(ps(
      `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`
    )
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)))
  : Array.from(new Set(unixPortPids()));

const stopped = [];
for (const pid of pids) {
  const commandLine = process.platform === "win32"
    ? ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`)
    : unixCommandLine(pid);
  const lower = commandLine.toLowerCase();
  const ownsWorkspace = lower.includes(workspace);
  const looksLikeVite = lower.includes("vite") && lower.includes(String(port));
  if (!ownsWorkspace && !looksLikeVite) continue;
  const stoppedProcess = process.platform === "win32" ? taskkill(pid) : unixKill(pid);
  if (stoppedProcess) stopped.push(pid);
}

if (stopped.length > 0) {
  process.stdout.write(`[dev] cleaned port ${port}: ${stopped.join(", ")}\n`);
}
