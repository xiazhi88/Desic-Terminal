import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { assertAiSmokeConfig, loadAiSmokeConfig } from "./load-ai-smoke-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const timeoutMs = Number(process.env.DESIC_AI_SMOKE_TIMEOUT_MS || 180_000);
const apiKey = process.env.DESIC_AI_API_KEY;
const config = await loadAiSmokeConfig();
assertAiSmokeConfig({ ...config, apiKey: apiKey || config.apiKey });

if (!apiKey && !config.apiKey) {
  throw new Error("DESIC_AI_API_KEY is required for the subagent smoke test.");
}

const sidecar = spawn(process.execPath, [resolve(root, "scripts", "cline-sidecar.mjs")], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    DESIC_AI_API_KEY: apiKey || config.apiKey || ""
  }
});

let finalText = "";
let sawAgent = false;
let sawSpawnTool = false;
let sawDone = false;
const events = [];

function send(command) {
  sidecar.stdin.write(`${JSON.stringify(command)}\n`);
}

function inspectEvent(event) {
  events.push(event);
  if (event.type === "delta" && event.channel !== "reasoning") {
    finalText += event.content || "";
  }
  if (event.type === "toolCall" && (String(event.name || "").startsWith("subagent_") || event.name === "spawn_agent")) {
    sawSpawnTool = true;
  }
  if (event.type === "agentStart" || event.type === "agentDone") {
    sawAgent = true;
  }
  if (event.type === "done") {
    sawDone = true;
  }
  if (event.type === "error") {
    throw new Error(event.error || "sidecar emitted an error");
  }
}

readline.createInterface({ input: sidecar.stdout, crlfDelay: Infinity }).on("line", (line) => {
  try {
    const event = JSON.parse(line);
    inspectEvent(event);
    if (event.type === "status" || event.type === "toolCall" || event.type === "agentStart" || event.type === "agentDone" || event.type === "done") {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  } catch {
    process.stderr.write(`[sidecar:raw] ${line}\n`);
  }
});
readline.createInterface({ input: sidecar.stderr, crlfDelay: Infinity }).on("line", (line) => {
  process.stderr.write(`[sidecar] ${line}\n`);
});

const sessionId = `subagent-smoke-${Date.now()}`;
const prompt = [
  "请使用一个子代理完成这次检查。",
  "子代理任务：只返回“子代理正常”。",
  "主助手拿到子代理结果后，只输出“主代理收到：子代理正常”。"
].join("\n");

const abortTimer = setTimeout(() => {
  sidecar.kill();
  const types = events.map((event) => event.type).join(", ");
  throw new Error(`subagent smoke timed out after ${timeoutMs}ms; events=${types}; text=${finalText}`);
}, timeoutMs);

send({
  type: "sendMessage",
  sessionId,
  config: {
    ...config,
    apiKey: apiKey || config.apiKey,
    stream: true,
    enableTools: true,
    enableSpawnAgent: true,
    enableAgentTeams: true,
    maxIterations: 4
  },
  messages: [{ id: "u1", role: "user", content: prompt }]
});

await new Promise((resolvePromise, reject) => {
  const started = Date.now();
  const timer = setInterval(() => {
    if (sawDone) {
      clearInterval(timer);
      resolvePromise();
      return;
    }
    if (Date.now() - started > timeoutMs) {
      clearInterval(timer);
      reject(new Error(`timeout waiting for subagent smoke done; text=${finalText}`));
    }
  }, 100);
  sidecar.on("error", reject);
});

clearTimeout(abortTimer);
if (!sawAgent && !sawSpawnTool) {
  throw new Error(`subagent was not observed; text=${finalText}; events=${events.map((event) => event.type).join(",")}`);
}
if (!finalText.includes("子代理正常")) {
  throw new Error(`expected final text to include 子代理正常; got: ${finalText}`);
}

send({ type: "shutdown" });
sidecar.stdin.end();
sidecar.kill();

process.stdout.write(
  `[subagent-smoke] ok events=${events.length} sawAgent=${sawAgent} sawSpawnTool=${sawSpawnTool} text=${finalText.trim()}\n`
);
