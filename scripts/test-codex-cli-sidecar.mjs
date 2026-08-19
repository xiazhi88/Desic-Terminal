import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mockCli = resolve(root, "scripts/fixtures/mock-codex-cli.mjs");
if (process.platform !== "win32") await chmod(mockCli, 0o755);

const sidecar = spawn(process.execPath, [resolve(root, "scripts/cline-sidecar.mjs")], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"]
});
const failAfterTool = process.env.DESIC_MOCK_CODEX_FAIL_AFTER_TOOL === "1";
const exitAfterTool = process.env.DESIC_MOCK_CODEX_EXIT_AFTER_TOOL === "1";
const failureMode = failAfterTool || exitAfterTool;
const sessionId = `codex-sidecar-test-${failureMode ? "failure" : "success"}-${Date.now()}`;
const events = [];
let stderr = "";
let sent = false;
let settled = false;
let requestStartedAt = 0;

const result = await new Promise((resolveTest, rejectTest) => {
  const timeout = setTimeout(() => rejectTest(new Error(
    `Codex sidecar integration test timed out: ${JSON.stringify(events.slice(-12))}; stderr=${stderr.slice(-1200)}`
  )), 45_000);
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    sidecar.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    setTimeout(() => sidecar.kill("SIGTERM"), 500).unref();
    if (error) rejectTest(error);
    else resolveTest(events);
  };
  sidecar.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  readline.createInterface({ input: sidecar.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    events.push(event);
    if (!sent && event.type === "status" && event.sessionId === "system") {
      sent = true;
      requestStartedAt = Date.now();
      sidecar.stdin.write(`${JSON.stringify({
        type: "sendMessage",
        sessionId,
        config: {
          provider: "openai-codex-cli",
          model: "gpt-mock-codex",
          baseUrl: "local://codex-cli",
          apiKey: "",
          localCliPath: mockCli,
          codexProviderRoute: {
            providerId: "PrivateGateway",
            name: "Private Gateway",
            baseUrl: "https://gateway.example.invalid/v1",
            wireApi: "responses",
            requiresOpenaiAuth: true,
            supportsWebsockets: false
          },
          permissionMode: "advisor",
          reasoningDepth: "low",
          enableTools: true,
          enableSpawnAgent: true,
          enableAgentTeams: false,
          maxIterations: 6,
          requestTimeoutMs: exitAfterTool ? undefined : failAfterTool ? 5_000 : 500,
          enabledSkills: [],
          activeSkillIds: []
        },
        messages: [{
          role: "user",
          content: failAfterTool
            ? "MOCK_FAIL_AFTER_TOOL 调用 spawn_agent，让子代理读取 BTC-USDT-SWAP ticker。"
            : exitAfterTool
              ? "MOCK_EXIT_AFTER_TOOL 调用 spawn_agent，让子代理读取 BTC-USDT-SWAP ticker。"
              : "调用 spawn_agent，让子代理读取 BTC-USDT-SWAP ticker。"
        }]
      })}\n`);
    }
    if (event.type === "toolExecuteRequest" && event.toolName === "market.readTicker") {
      sidecar.stdin.write(`${JSON.stringify({
        type: "toolExecuteResult",
        sessionId,
        executionId: event.executionId,
        ok: true,
        result: {
          instId: "BTC-USDT-SWAP",
          last: "64123.4",
          normalMarketSize: 500,
          observedAt: Date.now()
        }
      })}\n`);
    }
    if (event.sessionId === sessionId && event.type === "done") finish();
  });
  sidecar.on("exit", (code) => {
    if (!settled) finish(new Error(`sidecar exited early with code ${code}: ${stderr.slice(-1000)}`));
  });
}).catch((error) => {
  sidecar.kill("SIGTERM");
  throw error;
});

const sessionEvents = result.filter((event) => event.sessionId === sessionId);
assert.ok(Date.now() - requestStartedAt > 500, "active provider events should extend the idle timeout");
assert.equal(
  sessionEvents.find((event) => String(event.message || "").includes("Tool execution is disabled")),
  undefined
);
assert.ok(sessionEvents.some((event) => event.type === "toolCall" && event.name === "spawn_agent"));
assert.ok(sessionEvents.some((event) => event.type === "toolCall" && event.name === "market.readTicker"));
assert.ok(sessionEvents.some((event) => event.type === "toolExecuteRequest" && event.toolName === "market.readTicker"));
assert.ok(sessionEvents.some((event) => event.type === "toolResult" && event.name === "market.readTicker" && event.ok));
const reasoningSummaries = sessionEvents.filter((event) => (
  event.type === "delta"
  && event.channel === "reasoning"
  && event.reasoningSummary === true
));
if (failureMode) {
  const failureElapsedMs = Date.now() - requestStartedAt;
  assert.ok(
    failureElapsedMs < 4_500,
    `provider failure should beat the explicit test timeout: elapsed=${failureElapsedMs} events=${JSON.stringify(sessionEvents.slice(-8))}`
  );
  assert.equal(reasoningSummaries.map((event) => event.content).join(""), "Inspecting inputsChecking constraints");
  assert.equal(new Set(reasoningSummaries.map((event) => event.reasoningId)).size, 2);
  assert.ok(sessionEvents.some((event) => (
    event.type === "error"
    && (failAfterTool
      ? String(event.message || "").includes("mock provider failed after tool")
      : /exited|closed|terminated|Codex/i.test(String(event.message || "")))
  )));
  assert.equal(sessionEvents.at(-1)?.type, "done");
  assert.equal(sessionEvents.at(-1)?.finishReason, "error");
  console.log(exitAfterTool
    ? "codex cli sidecar silent exit integration passed"
    : "codex cli sidecar provider failure integration passed");
} else {
  assert.equal(
    reasoningSummaries.map((event) => event.content).join(""),
    "Inspecting inputsChecking constraintsPlanning response",
    `missing Codex reasoning summary metadata: ${JSON.stringify(sessionEvents.filter((event) => event.channel === "reasoning"))}`
  );
  assert.equal(new Set(reasoningSummaries.map((event) => event.reasoningId)).size, 3);
  assert.ok(sessionEvents.some((event) => event.type === "delta" && event.channel === "text-preview"));
  assert.ok(sessionEvents.some((event) => event.type === "delta" && event.channel === "text-final"));
  assert.equal(
    sessionEvents.some((event) => String(event.content || event.message || "").includes("Codex CLI 已完成工具调用")),
    false
  );
  assert.notEqual(sessionEvents.at(-1)?.finishReason, "error");
  console.log("codex cli sidecar MCP and subagent integration passed");
}
