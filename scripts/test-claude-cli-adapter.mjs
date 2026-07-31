import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRegisteredHandlerAsync } from "@cline/llms";
import {
  claudeErrorMessage,
  cleanupClaudeToolBridges,
  mapClaudeStreamEvent,
  normalizeClaudeUsage,
  registerClaudeToolBridge,
  registerDesicClaudeCliHandler,
  toClaudePrompt
} from "./claude-cli-adapter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mockCli = resolve(root, "scripts/fixtures/mock-claude-cli.mjs");

assert.match(toClaudePrompt([
  { role: "user", content: "读取行情" },
  { role: "assistant", content: [{ type: "text", text: "正在读取" }] }
]), /USER:\n读取行情[\s\S]*ASSISTANT:\n正在读取/);

assert.deepEqual(normalizeClaudeUsage({
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 10
}), {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 10,
  thoughtsTokenCount: 0
});

assert.deepEqual(mapClaudeStreamEvent({
  type: "stream_event",
  event: { delta: { type: "text_delta", text: "完成" } }
}, "response-1"), {
  type: "text",
  id: "response-1",
  text: "完成"
});
assert.deepEqual(mapClaudeStreamEvent({
  type: "stream_event",
  event: { delta: { type: "thinking_delta", thinking: "分析" } }
}, "response-1"), {
  type: "reasoning",
  id: "response-1",
  reasoning: "分析"
});
assert.equal(mapClaudeStreamEvent({ type: "assistant" }, "response-1"), null);
assert.match(claudeErrorMessage("Failed to authenticate. API Error: 403 Request not allowed"), /403 Request not allowed/);
assert.doesNotMatch(
  claudeErrorMessage("failed", "Authorization: Bearer sk-ant-test-only-placeholder"),
  /sk-ant-test-only-placeholder/
);

registerDesicClaudeCliHandler();
const toolEvents = [];
let receivedContext;
const bridgeId = registerClaudeToolBridge({
  sessionId: "claude-adapter-test",
  runtimeSessionId: "runtime-test",
  tools: [{
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
      return { instId: input.instId, last: "64123.4" };
    }
  }],
  cliPath: mockCli,
  cwd: root,
  reasoningEffort: "medium",
  maxTurns: 8,
  onToolEvent: (event) => toolEvents.push(event)
});
const handler = await getRegisteredHandlerAsync("claude-code", {
  providerId: "claude-code",
  modelId: "claude-sonnet-4-6",
  claudeCode: { desicBridgeId: bridgeId }
});
assert.equal(handler.getModel().id, "claude-sonnet-4-6");
const parts = [];
for await (const part of handler.createMessage("Only use Desic tools.", [
  { role: "user", content: "读取 BTC-USDT-SWAP ticker" }
])) {
  parts.push(part);
}
assert.equal(parts.filter((part) => part.type === "reasoning").map((part) => part.reasoning).join(""), "读取受控工具。");
assert.equal(parts.filter((part) => part.type === "text").map((part) => part.text).join(""), "BTC-USDT-SWAP last=64123.4");
assert.deepEqual(parts.find((part) => part.type === "usage"), {
  type: "usage",
  id: parts.find((part) => part.type === "usage").id,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 10,
  thoughtsTokenCount: 0
});
assert.equal(parts.at(-1)?.type, "done");
assert.equal(parts.at(-1)?.success, true);
assert.equal(toolEvents[0]?.type, "tool-started");
assert.equal(toolEvents[1]?.type, "tool-finished");
assert.equal(receivedContext?.metadata?.providerId, "claude-code");
cleanupClaudeToolBridges("claude-adapter-test");

const missingBridgeId = registerClaudeToolBridge({
  sessionId: "claude-missing-cli-test",
  runtimeSessionId: "runtime-missing",
  tools: [],
  cliPath: ""
});
const missingHandler = await getRegisteredHandlerAsync("claude-code", {
  providerId: "claude-code",
  modelId: "sonnet",
  claudeCode: { desicBridgeId: missingBridgeId }
});
const missingStream = missingHandler.createMessage("system", [{ role: "user", content: "hello" }]);
const missing = await missingStream.next();
assert.equal(missing.value.type, "done");
assert.equal(missing.value.success, false);
assert.match(missing.value.error, /Claude Code CLI/);
cleanupClaudeToolBridges("claude-missing-cli-test");

console.log("claude cli adapter tests passed");
