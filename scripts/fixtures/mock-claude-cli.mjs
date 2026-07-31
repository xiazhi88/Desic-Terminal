#!/usr/bin/env node

import { readFile } from "node:fs/promises";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readPrompt() {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  return prompt;
}

async function callMcp(config, allowedTools, prompt) {
  const [serverName, server] = Object.entries(config.mcpServers || {})[0] || [];
  if (!serverName || !server?.url) throw new Error("mock Claude did not receive an MCP server");
  if (server.type !== "http" || server.alwaysLoad !== true) {
    throw new Error("mock Claude did not receive an always-loaded HTTP MCP server");
  }
  const available = allowedTools.map((name) => name.split("__").at(-1));
  const tool = available.includes("spawn_agent") && prompt.includes("spawn_agent")
    ? "spawn_agent"
    : available.includes("market_readTicker")
      ? "market_readTicker"
      : available[0];
  if (!tool) throw new Error("mock Claude did not receive an allowed Desic tool");
  const input = tool === "spawn_agent"
    ? {
        systemPrompt: "你是只读行情子代理，必须使用 market.readTicker 获取 BTC-USDT-SWAP。",
        task: "调用 market.readTicker，返回 last。"
      }
    : { instId: "BTC-USDT-SWAP" };
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(server.headers || {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: input }
    })
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || `mock MCP call failed: HTTP ${response.status}`);
  }
  return { tool, input, result: body.result };
}

async function main() {
  const args = process.argv.slice(2);
  for (const flag of [
    "-p",
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence"
  ]) {
    if (!args.includes(flag)) throw new Error(`mock Claude is missing isolation flag: ${flag}`);
  }
  if (valueAfter(args, "--output-format") !== "stream-json") {
    throw new Error("mock Claude requires stream-json output");
  }
  if (valueAfter(args, "--permission-mode") !== "dontAsk") {
    throw new Error("mock Claude requires dontAsk permission mode");
  }
  if (valueAfter(args, "--setting-sources") !== "user") {
    throw new Error("mock Claude must preserve the user settings route");
  }
  if (valueAfter(args, "--tools") !== "") {
    throw new Error("mock Claude native tools were not disabled");
  }
  const settings = JSON.parse(valueAfter(args, "--settings") || "{}");
  if (settings.disableAllHooks !== true) throw new Error("mock Claude hooks were not disabled");
  const prompt = await readPrompt();
  const mcpConfig = JSON.parse(await readFile(valueAfter(args, "--mcp-config"), "utf8"));
  const allowedTools = String(valueAfter(args, "--allowedTools") || "")
    .split(/[\s,]+/)
    .filter(Boolean);

  emit({ type: "system", subtype: "init", session_id: `mock-${process.pid}` });
  emit({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "读取受控工具。" } }
  });
  const call = await callMcp(mcpConfig, allowedTools, prompt);
  const answer = call.tool === "spawn_agent"
    ? "子代理已完成行情读取。"
    : "BTC-USDT-SWAP last=64123.4";
  emit({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: answer } }
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: answer,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 10
    }
  });
}

main().catch((error) => {
  emit({
    type: "result",
    subtype: "error",
    is_error: true,
    result: error?.message || String(error),
    usage: { input_tokens: 0, output_tokens: 0 }
  });
  process.exitCode = 1;
});
