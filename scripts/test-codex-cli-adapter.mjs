import assert from "node:assert/strict";
import { getRegisteredHandlerAsync } from "@cline/llms";
import {
  cleanupCodexToolBridges,
  codexErrorMessage,
  codexProviderMetadataError,
  codexIsolationOverrides,
  codexProviderOverrides,
  createCodexBridgeTool,
  mapCodexProviderPart,
  normalizeCodexAppServerEvent,
  normalizeCodexUsage,
  resolveWindowsCodexCliPath,
  registerCodexToolBridge,
  registerDesicCodexCliHandler,
  toCodexMessages,
  updateCodexToolBridgeActivity
} from "./codex-cli-adapter.mjs";

const windowsNpmCodex = "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd";
const resolvedWindowsCodex = resolveWindowsCodexCliPath(
  "codex",
  { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
  (candidate) => candidate === windowsNpmCodex
);
if (process.platform === "win32") {
  assert.equal(resolvedWindowsCodex, windowsNpmCodex);
}

assert.deepEqual(toCodexMessages([
  { role: "user", content: "读取行情" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "不应写回历史上下文" },
      { type: "text", text: "先读取行情" },
      { type: "tool_use", name: "market_readTicker", input: { instId: "BTC-USDT-SWAP" } }
    ]
  }
]), [
  { role: "user", content: "读取行情" },
  {
    role: "assistant",
    content: "先读取行情\n\n[Tool call: market_readTicker]\n{\"instId\":\"BTC-USDT-SWAP\"}"
  }
]);

const isolation = codexIsolationOverrides();
assert.equal(isolation.web_search, "disabled");
assert.equal(isolation["features.shell_tool"], false);
assert.equal(isolation["features.unified_exec"], false);
assert.equal(isolation["features.multi_agent"], false);
assert.equal(isolation["agents.enabled"], undefined);
assert.equal(Object.keys(isolation).some((key) => key.startsWith("mcp_servers.")), false);
const openIsolation = codexIsolationOverrides(true);
assert.equal(openIsolation.web_search, "live");
assert.equal(openIsolation["features.shell_tool"], true);

const providerOverrides = codexProviderOverrides({
  providerId: "PrivateGateway",
  name: "Private Gateway",
  baseUrl: "https://gateway.example.invalid/v1/",
  wireApi: "responses",
  requiresOpenaiAuth: true,
  envKey: "OPENAI_API_KEY",
  supportsWebsockets: false,
  requestMaxRetries: 4,
  streamMaxRetries: 2,
  streamIdleTimeoutMs: 120_000,
  httpHeaders: { Authorization: "MUST_NOT_BE_PASSED" }
});
assert.equal(providerOverrides.model_provider, "PrivateGateway");
assert.equal(
  providerOverrides["model_providers.PrivateGateway.base_url"],
  "https://gateway.example.invalid/v1"
);
assert.equal(providerOverrides["model_providers.PrivateGateway.requires_openai_auth"], true);
assert.equal(providerOverrides["model_providers.PrivateGateway.env_key"], "OPENAI_API_KEY");
assert.equal(JSON.stringify(providerOverrides).includes("MUST_NOT_BE_PASSED"), false);
assert.deepEqual(codexProviderOverrides({
  providerId: "unsafe.provider",
  baseUrl: "https://gateway.example.invalid/v1",
  wireApi: "responses"
}), {});
assert.deepEqual(codexProviderOverrides({
  providerId: "PrivateGateway",
  baseUrl: "https://user:password@gateway.example.invalid/v1",
  wireApi: "responses"
}), {});
assert.deepEqual(codexProviderOverrides({
  providerId: "PrivateGateway",
  baseUrl: "https://gateway.example.invalid/v1?token=must-not-pass",
  wireApi: "responses"
}), {});
assert.deepEqual(codexProviderOverrides(undefined), {});
const defaultRetryOverrides = codexProviderOverrides(undefined, { defaultRetryPolicy: true });
assert.equal(defaultRetryOverrides["model_providers.OpenAI.request_max_retries"], 0);
assert.equal(defaultRetryOverrides["model_providers.OpenAI.stream_max_retries"], 0);
assert.equal(defaultRetryOverrides["model_providers.OpenAI.stream_idle_timeout_ms"], 30_000);

const detailedError = codexErrorMessage({
  message: "Codex CLI exited with code 1",
  data: {
    stderr: "(node:12345) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n(Use `node --trace-warnings ...` to show where the warning was created)\nError loading config.toml: invalid transport\nin `mcp_servers.plugin`\nAuthorization: Bearer test-only-placeholder"
  }
});
assert.match(detailedError, /invalid transport/);
assert.doesNotMatch(detailedError, /UNDICI-EHPA/);
assert.doesNotMatch(detailedError, /test-only-placeholder/);
assert.match(codexErrorMessage({
  message: "Codex CLI exited with code 1",
  data: { stderr: "failed to connect: HTTP error: 403 Forbidden, url: wss://api.openai.com/v1/responses" }
}), /代理出口地区或账户权限/);
assert.equal(codexProviderMetadataError({
  providerMetadata: { "codex-cli": { error: "turn.failed: Invalid API key" } }
}), "turn.failed: Invalid API key");
assert.deepEqual(
  mapCodexProviderPart({ type: "text-delta", text: "完成" }, "response-1"),
  { type: "text", id: "response-1", text: "完成" }
);
assert.deepEqual(
  mapCodexProviderPart({ type: "reasoning-delta", id: "reasoning-1", text: "分析" }, "response-1"),
  {
    type: "reasoning",
    id: "response-1",
    reasoning: "分析",
    details: { provider: "codex-app-server", itemId: "reasoning-1", isSummary: false }
  }
);
assert.deepEqual(
  mapCodexProviderPart({
    type: "reasoning-delta",
    id: "reasoning-2",
    text: "核对输入",
    providerMetadata: { "codex-app-server": { isSummary: true } }
  }, "response-1"),
  {
    type: "reasoning",
    id: "response-1",
    reasoning: "核对输入",
    details: { provider: "codex-app-server", itemId: "reasoning-2", isSummary: true }
  }
);
assert.equal(mapCodexProviderPart({
  type: "tool-call",
  toolName: "market_readTicker",
  providerExecuted: true
}, "response-1"), null);
assert.equal(mapCodexProviderPart({ type: "tool-result", result: { ok: true } }, "response-1"), null);

const normalizedTurnCompleted = normalizeCodexAppServerEvent({
  method: "turn/completed",
  params: {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [
        { id: "answer-1", type: "agentMessage", text: "完成" },
        { id: "reasoning-1", type: "reasoning" },
        { id: "future-1", type: "dynamicToolCall", tool: "future" }
      ]
    }
  }
});
assert.equal(normalizedTurnCompleted.params.turn.error, null);
assert.equal(normalizedTurnCompleted.params.turn.items.length, 2);
assert.equal(normalizedTurnCompleted.params.turn.items[0].phase, null);
assert.deepEqual(normalizedTurnCompleted.params.turn.items[1].summary, []);
assert.deepEqual(normalizedTurnCompleted.params.turn.items[1].content, []);
const normalizedTurnStart = normalizeCodexAppServerEvent({
  id: 3,
  result: { turn: { id: "turn-2", status: "inProgress", items: [] } }
});
assert.equal(normalizedTurnStart.result.turn.error, null);
const normalizedError = normalizeCodexAppServerEvent({
  method: "error",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    willRetry: false,
    error: { message: "provider failed" }
  }
});
assert.equal(normalizedError.params.error.codexErrorInfo, null);
assert.equal(normalizedError.params.error.additionalDetails, null);
const normalizedNewCodexError = normalizeCodexAppServerEvent({
  method: "error",
  params: {
    error: { message: "budget exhausted", codexErrorInfo: "sessionBudgetExceeded" }
  }
});
assert.equal(normalizedNewCodexError.params.error.codexErrorInfo, "other");
assert.match(normalizedNewCodexError.params.error.additionalDetails, /sessionBudgetExceeded/);
const normalizedUsageEvent = normalizeCodexAppServerEvent({
  method: "thread/tokenUsage/updated",
  params: { tokenUsage: { total: {}, last: {} } }
});
assert.equal(normalizedUsageEvent.params.tokenUsage.modelContextWindow, null);

assert.deepEqual(normalizeCodexUsage({
  inputTokens: { total: 120 },
  outputTokens: 40,
  inputTokenDetails: { cachedTokens: 20 },
  outputTokenDetails: { reasoningTokens: 10 }
}), {
  inputTokens: 120,
  outputTokens: 40,
  cacheReadTokens: 20,
  thoughtsTokenCount: 10
});

const toolEvents = [];
let receivedContext;
const bridgedTool = createCodexBridgeTool({
  runtimeSessionId: "runtime-1",
  agentId: "agent-1",
  parentAgentId: "parent-1",
  onToolEvent: (event) => toolEvents.push(event)
}, {
  name: "market_readTicker",
  description: "Read ticker",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["instId"],
    properties: { instId: { type: "string" } }
  },
  execute: async (input, context) => {
    receivedContext = context;
    return { instId: input.instId, last: "64100" };
  }
});
assert.deepEqual(await bridgedTool.execute({ instId: "BTC-USDT-SWAP" }), {
  instId: "BTC-USDT-SWAP",
  last: "64100"
});
assert.equal(receivedContext.agentId, "agent-1");
assert.equal(receivedContext.metadata.providerExecuted, true);
assert.equal(toolEvents[0].type, "tool-started");
assert.equal(toolEvents[1].type, "tool-finished");
assert.equal(toolEvents[0].toolCall.toolCallId, toolEvents[1].toolCall.toolCallId);
await assert.rejects(() => bridgedTool.execute({}), /工具参数未通过校验/);

registerDesicCodexCliHandler();
const bridgeId = registerCodexToolBridge({
  sessionId: "codex-adapter-test",
  runtimeSessionId: "runtime-test",
  tools: [],
  cliPath: "",
  cwd: process.cwd(),
  reasoningEffort: "medium"
});
assert.equal(updateCodexToolBridgeActivity("codex-adapter-test", () => {}), 1);
const handler = await getRegisteredHandlerAsync("openai-codex-cli", {
  providerId: "openai-codex-cli",
  modelId: "gpt-test-codex",
  codex: { desicBridgeId: bridgeId }
});
assert.equal(handler.getModel().id, "gpt-test-codex");
const stream = handler.createMessage("system", [{ role: "user", content: "hello" }]);
const first = await stream.next();
assert.equal(first.value.type, "done");
assert.equal(first.value.success, false);
assert.match(first.value.error, /Codex CLI/);
cleanupCodexToolBridges("codex-adapter-test");
assert.equal(updateCodexToolBridgeActivity("codex-adapter-test", () => {}), 0);

console.log("codex cli adapter tests passed");
