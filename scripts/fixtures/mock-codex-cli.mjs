#!/usr/bin/env node

import readline from "node:readline";

function parseConfigValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readConfigOverrides(args) {
  const values = new Map();
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-c" && args[index] !== "--config") continue;
    const entry = String(args[index + 1] || "");
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    values.set(entry.slice(0, separator), parseConfigValue(entry.slice(separator + 1)));
    index += 1;
  }
  return values;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readStdin() {
  for await (const _chunk of process.stdin) {
    // The provider sends the rendered prompt over stdin.
  }
}

async function callMcp(config) {
  const urlEntry = [...config.entries()].find(([key]) => /^mcp_servers\.[^.]+\.url$/.test(key));
  if (!urlEntry) throw new Error("mock Codex did not receive an MCP URL");
  const [urlKey, url] = urlEntry;
  const prefix = urlKey.slice(0, -4);
  const enabledTools = config.get(`${prefix}.enabled_tools`);
  const tools = Array.isArray(enabledTools) ? enabledTools : [];
  const tool = tools.includes("spawn_agent") ? "spawn_agent" : "market_readTicker";
  const args = tool === "spawn_agent"
    ? {
        systemPrompt: "你是只读行情子代理，必须使用 market.readTicker 获取 BTC-USDT-SWAP。",
        task: "调用 market.readTicker，返回 last。"
      }
    : { instId: "BTC-USDT-SWAP" };
  const configuredHeaders = config.get(`${prefix}.http_headers`);
  const authorization = config.get(`${prefix}.http_headers.Authorization`)
    || configuredHeaders?.Authorization
    || configuredHeaders?.authorization;
  const response = await fetch(String(url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization: String(authorization) } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args }
    })
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || `mock MCP call failed: HTTP ${response.status}`);
  }
  return { server: prefix.slice("mcp_servers.".length), tool, args, result: body.result };
}

function validateConfig(config) {
  if (config.get("model_provider") !== "PrivateGateway") {
    throw new Error("mock Codex did not receive the selected custom model_provider");
  }
  if (config.get("model_providers.PrivateGateway.base_url") !== "https://gateway.example.invalid/v1") {
    throw new Error("mock Codex did not receive the custom Provider base_url");
  }
  if (config.get("model_providers.PrivateGateway.wire_api") !== "responses") {
    throw new Error("mock Codex did not receive the Provider wire_api");
  }
  if (config.get("model_providers.PrivateGateway.requires_openai_auth") !== true) {
    throw new Error("mock Codex did not receive the Provider authentication mode");
  }
  const mcpApprovalEntry = [...config.entries()].find(([key]) => (
    /^mcp_servers\.[^.]+\.default_tools_approval_mode$/.test(key)
  ));
  if (mcpApprovalEntry?.[1] !== "approve") {
    throw new Error("mock Codex did not receive scoped MCP tool approval");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockTurn(id, status = "inProgress", items = []) {
  return { id, items, status };
}

async function runAppServer() {
  let config = new Map();
  let threadId = `mock-thread-${process.pid}`;
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      emit({ id: request.id, result: { userAgent: "codex-cli/0.200.0", capabilities: {} } });
      continue;
    }
    if (request.method === "thread/start") {
      config = new Map(Object.entries(request.params?.config || {}));
      validateConfig(config);
      emit({ id: request.id, result: { thread: { id: threadId } } });
      emit({ method: "thread/started", params: { thread: { id: threadId } } });
      continue;
    }
    if (request.method === "turn/start") {
      threadId = request.params?.threadId || threadId;
      const inputText = JSON.stringify(request.params?.input || "");
      const failAfterTool = inputText.includes("MOCK_FAIL_AFTER_TOOL");
      const exitAfterTool = inputText.includes("MOCK_EXIT_AFTER_TOOL");
      const turnId = `mock-turn-${Date.now()}`;
      emit({ id: request.id, result: { turn: mockTurn(turnId) } });
      await wait(15);
      emit({ method: "turn/started", params: { threadId, turn: mockTurn(turnId) } });
      const firstReasoningId = `mock-reasoning-input-${process.pid}-${Date.now()}`;
      const firstReasoning = {
        id: firstReasoningId,
        type: "reasoning",
        summary: ["Inspecting inputs", "Checking constraints"]
      };
      emit({
        method: "item/reasoning/summaryTextDelta",
        params: { threadId, turnId, itemId: firstReasoningId, summaryIndex: 0, delta: "Inspecting " }
      });
      emit({
        method: "item/reasoning/summaryTextDelta",
        params: { threadId, turnId, itemId: firstReasoningId, summaryIndex: 0, delta: "inputs" }
      });
      emit({
        method: "item/reasoning/summaryTextDelta",
        params: { threadId, turnId, itemId: firstReasoningId, summaryIndex: 1, delta: "Checking constraints" }
      });
      emit({ method: "item/completed", params: { threadId, turnId, item: firstReasoning } });
      const call = await callMcp(config);
      const toolItem = {
        id: `mock-tool-${process.pid}-${Date.now()}`,
        type: "mcpToolCall",
        server: call.server,
        tool: call.tool,
        status: "inProgress",
        arguments: call.args
      };
      emit({ method: "item/started", params: { threadId, turnId, item: toolItem } });
      await wait(300);
      const completedTool = { ...toolItem, status: "completed", result: call.result, durationMs: 1 };
      emit({ method: "item/completed", params: { threadId, turnId, item: completedTool } });
      if (failAfterTool) {
        emit({
          method: "error",
          params: {
            threadId,
            turnId,
            willRetry: false,
            error: { message: "mock provider failed after tool", codexErrorInfo: "other" }
          }
        });
        continue;
      }
      if (exitAfterTool) {
        process.exit(0);
      }
      await wait(300);
      const secondReasoningId = `mock-reasoning-output-${process.pid}-${Date.now()}`;
      const secondReasoning = { id: secondReasoningId, type: "reasoning", summary: ["Planning response"] };
      emit({
        method: "item/reasoning/summaryTextDelta",
        params: { threadId, turnId, itemId: secondReasoningId, summaryIndex: 0, delta: "Planning response" }
      });
      emit({ method: "item/completed", params: { threadId, turnId, item: secondReasoning } });
      const answerId = `mock-answer-${process.pid}-${Date.now()}`;
      const answer = call.tool === "spawn_agent"
        ? "子代理已完成行情读取。"
        : "BTC-USDT-SWAP last=64123.4";
      const midpoint = Math.max(1, Math.floor(answer.length / 2));
      emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: answerId, delta: answer.slice(0, midpoint) } });
      await wait(15);
      emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: answerId, delta: answer.slice(midpoint) } });
      const answerItem = { id: answerId, type: "agentMessage", text: answer };
      emit({ method: "item/completed", params: { threadId, turnId, item: answerItem } });
      emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 0 },
            last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 0 }
          }
        }
      });
      emit({
        method: "turn/completed",
        params: {
          threadId,
          turn: mockTurn(turnId, "completed", [firstReasoning, completedTool, secondReasoning, answerItem])
        }
      });
      continue;
    }
    if (request.method === "turn/interrupt") {
      emit({ id: request.id, result: {} });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "mcp" && args[1] === "list") {
    process.stdout.write("[]\n");
    return;
  }
  if (args[0] === "app-server") {
    await runAppServer();
    return;
  }
  if (args[0] !== "exec") throw new Error(`unsupported mock Codex command: ${args[0] || "empty"}`);
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral"]) {
    if (!args.includes(flag)) throw new Error(`mock Codex is missing isolation flag: ${flag}`);
  }
  await readStdin();
  const config = readConfigOverrides(args);
  validateConfig(config);
  emit({ type: "thread.started", thread_id: `mock-thread-${process.pid}` });
  emit({ type: "turn.started" });
  const call = await callMcp(config);
  const itemId = `mock-tool-${process.pid}`;
  emit({
    type: "item.started",
    item: {
      id: itemId,
      type: "mcp_tool_call",
      server: call.server,
      tool: call.tool,
      arguments: call.args,
      status: "in_progress"
    }
  });
  emit({
    type: "item.completed",
    item: {
      id: itemId,
      type: "mcp_tool_call",
      server: call.server,
      tool: call.tool,
      arguments: call.args,
      status: "completed",
      result: call.result
    }
  });
  emit({
    type: "item.completed",
    item: {
      id: `mock-answer-${process.pid}`,
      type: "assistant_message",
      text: call.tool === "spawn_agent" ? "子代理已完成行情读取。" : "BTC-USDT-SWAP last=64123.4"
    }
  });
  emit({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 10 } });
}

main().catch((error) => {
  const message = error?.message || String(error);
  process.stderr.write(`${message}\n`);
  if (process.argv.includes("app-server")) {
    emit({ id: null, error: { code: -32000, message } });
  } else {
    emit({ type: "turn.failed", error: { message } });
  }
  process.exitCode = 1;
});
