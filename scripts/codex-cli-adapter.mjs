import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { registerAsyncHandler } from "@cline/llms";
import { streamText } from "ai";
import { createCodexExec, createLocalMcpServer } from "ai-sdk-provider-codex-cli";
import Ajv from "ajv";

const CODEX_PROVIDER_ID = "openai-codex-cli";
const bridges = new Map();
const sessionBridgeIds = new Map();
const schemaValidators = new WeakMap();
const ajv = new Ajv({ allErrors: true, strict: false });
let registered = false;

const CODEX_WRAPPER_SOURCE = `#!/usr/bin/env node
import { spawn } from "node:child_process";

const actualPath = process.env.DESIC_CODEX_CLI_PATH;
if (!actualPath) {
  process.stderr.write("Desic Codex launcher is missing the verified CLI path\\n");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === "exec") {
  const isolationFlags = ["--ignore-user-config", "--ignore-rules", "--ephemeral"];
  for (let index = isolationFlags.length - 1; index >= 0; index -= 1) {
    if (!args.includes(isolationFlags[index])) args.splice(1, 0, isolationFlags[index]);
  }
}

const javascriptCli = /\\.(?:c|m)?js$/i.test(actualPath);
const windowsBatchCli = process.platform === "win32" && /\\.(?:cmd|bat)$/i.test(actualPath);
const command = javascriptCli ? process.execPath : actualPath;
const commandArgs = javascriptCli ? [actualPath, ...args] : args;
const child = spawn(command, commandArgs, {
  env: process.env,
  stdio: "inherit",
  // Windows cannot execute a .cmd/.bat file directly through CreateProcess.
  shell: windowsBatchCli,
  windowsHide: true
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  process.stderr.write(\`Unable to start Codex CLI: \${error?.message || String(error)}\\n\`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
`;

function textValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function messageBlockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return textValue(block.text);
  if (block.type === "file") return textValue(block.content);
  if (block.type === "tool_use" || block.type === "tool-call") {
    const name = block.name || block.toolName || "tool";
    return `[Tool call: ${name}]\n${textValue(block.input ?? block.arguments ?? {})}`;
  }
  if (block.type === "tool_result" || block.type === "tool-result") {
    return `[Tool result]\n${textValue(block.content ?? block.output ?? block.result)}`;
  }
  return "";
}

export function toCodexMessages(messages = []) {
  return messages.flatMap((message) => {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const content = typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.map(messageBlockText).filter(Boolean).join("\n\n")
        : "";
    return content.trim() ? [{ role, content }] : [];
  });
}

export function resolveWindowsCodexCliPath(cliPath, environment = process.env, pathExists = existsSync) {
  const configured = String(cliPath || "").trim();
  if (process.platform !== "win32" || !configured || isAbsolute(configured)) return configured;
  const filename = /\.(?:cmd|bat|exe|cjs|mjs|js)$/i.test(configured)
    ? configured
    : `${configured}.cmd`;
  const candidates = [
    environment.APPDATA && join(environment.APPDATA, "npm", filename),
    environment.USERPROFILE && join(environment.USERPROFILE, "AppData", "Roaming", "npm", filename)
  ].filter(Boolean);
  return candidates.find((candidate) => pathExists(candidate)) || configured;
}

function tokenCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (!value || typeof value !== "object") return 0;
  for (const key of ["total", "totalTokens", "tokens"]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) {
      return Math.max(0, Math.floor(value[key]));
    }
  }
  return 0;
}

export function normalizeCodexUsage(usage = {}) {
  return {
    inputTokens: tokenCount(usage.inputTokens ?? usage.input_tokens),
    outputTokens: tokenCount(usage.outputTokens ?? usage.output_tokens),
    cacheReadTokens: tokenCount(
      usage.cachedInputTokens
      ?? usage.cacheReadTokens
      ?? usage.inputTokenDetails?.cacheReadTokens
      ?? usage.inputTokenDetails?.cachedTokens
    ),
    thoughtsTokenCount: tokenCount(
      usage.reasoningTokens
      ?? usage.thoughtsTokenCount
      ?? usage.outputTokenDetails?.reasoningTokens
    )
  };
}

export function codexIsolationOverrides() {
  return {
    web_search: "disabled",
    "features.shell_tool": false,
    "features.unified_exec": false,
    "features.multi_agent": false,
    "features.apps": false,
    "features.hooks": false,
    "features.goals": false,
    "features.skill_mcp_dependency_install": false
  };
}

function validConfigId(value) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function validEnvironmentVariableName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function codexProviderOverrides(route) {
  if (!route || typeof route !== "object") return {};
  const providerId = String(route.providerId || "").trim();
  const name = String(route.name || providerId).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  const wireApi = String(route.wireApi || "responses").trim();
  let baseUrl;
  try {
    baseUrl = new URL(String(route.baseUrl || "").trim());
  } catch {
    return {};
  }
  if (
    !validConfigId(providerId)
    || !name
    || wireApi !== "responses"
    || !["http:", "https:"].includes(baseUrl.protocol)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
  ) {
    return {};
  }
  const prefix = `model_providers.${providerId}`;
  const overrides = {
    model_provider: providerId,
    [`${prefix}.name`]: name,
    [`${prefix}.base_url`]: baseUrl.href.replace(/\/$/, ""),
    [`${prefix}.wire_api`]: wireApi,
    [`${prefix}.requires_openai_auth`]: route.requiresOpenaiAuth === true
  };
  if (typeof route.envKey === "string" && validEnvironmentVariableName(route.envKey.trim())) {
    overrides[`${prefix}.env_key`] = route.envKey.trim();
  }
  if (typeof route.supportsWebsockets === "boolean") {
    overrides[`${prefix}.supports_websockets`] = route.supportsWebsockets;
  }
  for (const [routeKey, configKey, maximum] of [
    ["requestMaxRetries", "request_max_retries", 100],
    ["streamMaxRetries", "stream_max_retries", 100],
    ["streamIdleTimeoutMs", "stream_idle_timeout_ms", 3_600_000]
  ]) {
    const value = route[routeKey];
    if (Number.isSafeInteger(value) && value >= 0 && value <= maximum) {
      overrides[`${prefix}.${configKey}`] = value;
    }
  }
  return overrides;
}

export async function createIsolatedCodexCli(cliPath) {
  const directory = await mkdtemp(join(tmpdir(), "desic-codex-cli-"));
  const wrapperPath = join(directory, "codex-wrapper.mjs");
  try {
    await writeFile(wrapperPath, CODEX_WRAPPER_SOURCE, { encoding: "utf8", mode: 0o700 });
    return {
      path: wrapperPath,
      env: { DESIC_CODEX_CLI_PATH: resolveWindowsCodexCliPath(cliPath) },
      cleanup: () => rm(directory, { force: true, recursive: true })
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
}

function sanitizeCodexErrorDetail(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\(node:\d+\) \[UNDICI-EHPA\] Warning:[^\r\n]*(?:\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\))?/g, "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[API key redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/\s*\r?\n+\s*/g, "; ")
    .trim()
    .slice(0, 2_000);
}

function findCodexStderr(error, depth = 0) {
  if (!error || depth > 3) return "";
  if (typeof error?.data?.stderr === "string") return error.data.stderr;
  if (typeof error?.stderr === "string") return error.stderr;
  return findCodexStderr(error?.cause, depth + 1);
}

function summarizeCodexStderr(value) {
  const detail = sanitizeCodexErrorDetail(value);
  const lower = detail.toLowerCase();
  if (lower.includes("unsupported_country_region_territory")) {
    return "OpenAI 拒绝了当前地区的请求，请在全局配置 > 代理中切换到受支持地区的出口后重试";
  }
  if (lower.includes("403 forbidden") && lower.includes("api.openai.com")) {
    return "OpenAI 返回 403 Forbidden，当前代理出口地区或账户权限可能不受支持；请检查全局配置 > 代理后重试";
  }
  if (lower.includes("error loading config.toml")) {
    return `Codex 配置无效：${detail}`;
  }
  return detail;
}

export function codexErrorMessage(error) {
  const message = sanitizeCodexErrorDetail(error?.message || String(error) || "Codex CLI 运行失败");
  const stderr = summarizeCodexStderr(findCodexStderr(error));
  if (!stderr || message.includes(stderr)) return message || "Codex CLI 运行失败";
  return `${message || "Codex CLI 运行失败"}: ${stderr}`;
}

function bridgeToolContext(bridge, toolCallId) {
  return {
    sessionId: bridge.runtimeSessionId,
    agentId: bridge.agentId || bridge.runtimeSessionId,
    conversationId: bridge.runtimeSessionId,
    runId: bridge.runtimeSessionId,
    iteration: 1,
    toolCallId,
    signal: bridge.signal,
    metadata: {
      parentAgentId: bridge.parentAgentId,
      providerId: bridge.providerId || CODEX_PROVIDER_ID,
      providerExecuted: true
    }
  };
}

export function createCodexBridgeTool(bridge, agentTool) {
  let validate = schemaValidators.get(agentTool);
  if (!validate) {
    validate = ajv.compile(agentTool.inputSchema || { type: "object" });
    schemaValidators.set(agentTool, validate);
  }
  return {
    name: agentTool.name,
    description: agentTool.description,
    inputSchema: agentTool.inputSchema,
    execute: async (input) => {
      const normalizedInput = input && typeof input === "object" ? input : {};
      if (!validate(normalizedInput)) {
        const details = ajv.errorsText(validate.errors, { separator: "; " });
        throw new Error(`工具参数未通过校验：${details}`);
      }
      const toolCallId = `${bridge.toolCallPrefix || "codex"}_${randomUUID()}`;
      const startedAt = Date.now();
      const toolCall = {
        toolCallId,
        toolName: agentTool.name,
        input: normalizedInput,
        agentId: bridge.agentId,
        parentAgentId: bridge.parentAgentId,
        startedAt
      };
      bridge.onToolEvent?.({ type: "tool-started", iteration: 1, toolCall });
      try {
        const result = await agentTool.execute(toolCall.input, bridgeToolContext(bridge, toolCallId));
        bridge.onToolEvent?.({
          type: "tool-finished",
          iteration: 1,
          toolCall: { ...toolCall, output: result, endedAt: Date.now() },
          message: result
        });
        return result;
      } catch (error) {
        const message = error?.message || String(error);
        bridge.onToolEvent?.({
          type: "tool-finished",
          iteration: 1,
          toolCall: { ...toolCall, error: message, endedAt: Date.now() },
          message: { error: message }
        });
        throw error;
      }
    }
  };
}

export function mapCodexProviderPart(part, responseId) {
  if (part?.type === "text-delta" && part.text) {
    return { type: "text", id: responseId, text: part.text };
  }
  if (part?.type === "reasoning-delta" && part.text) {
    return { type: "reasoning", id: responseId, reasoning: part.text };
  }
  // Codex executes tool-call and tool-result parts itself. Returning null is
  // intentional: Cline must not execute provider-owned calls a second time.
  return null;
}

function registerSessionBridge(sessionId, bridgeId) {
  const ids = sessionBridgeIds.get(sessionId) || new Set();
  ids.add(bridgeId);
  sessionBridgeIds.set(sessionId, ids);
}

export function registerCodexToolBridge(options) {
  const bridgeId = `bridge_${randomUUID().replaceAll("-", "")}`;
  const tools = Array.isArray(options.tools) ? options.tools.filter((tool) => tool?.name && tool?.execute) : [];
  bridges.set(bridgeId, {
    ...options,
    bridgeId,
    tools,
    toolMap: new Map(tools.map((tool) => [tool.name, tool]))
  });
  registerSessionBridge(options.sessionId, bridgeId);
  return bridgeId;
}

export function cleanupCodexToolBridges(sessionId) {
  const ids = sessionBridgeIds.get(sessionId);
  if (!ids) return;
  for (const bridgeId of ids) bridges.delete(bridgeId);
  sessionBridgeIds.delete(sessionId);
}

function handlerModelInfo(config) {
  const fallback = {
    id: config.modelId,
    name: config.modelId,
    contextWindow: 200_000,
    maxTokens: 100_000,
    supportsImages: false,
    supportsPromptCache: false
  };
  return config.modelInfo ?? config.knownModels?.[config.modelId] ?? fallback;
}

function codexSettings(config, bridge, serverConfig, isolatedCli) {
  const enabledTools = bridge.tools.map((tool) => tool.name);
  return {
    codexPath: isolatedCli.path,
    allowNpx: false,
    cwd: bridge.cwd,
    env: isolatedCli.env,
    approvalMode: "never",
    sandboxMode: "read-only",
    skipGitRepoCheck: true,
    reasoningEffort: bridge.reasoningEffort,
    reasoningSummary: "auto",
    logger: false,
    rmcpClient: true,
    mcpServers: {
      [bridge.bridgeId]: {
        ...serverConfig,
        enabled: true,
        enabledTools,
        startupTimeoutSec: 10,
        toolTimeoutSec: 120
      }
    },
    configOverrides: {
      ...codexIsolationOverrides(),
      ...codexProviderOverrides(bridge.providerRoute),
      // Codex owns provider-executed MCP calls. Only the tools already filtered by
      // Desic policy are exposed on this authenticated, per-run loopback server.
      [`mcp_servers.${bridge.bridgeId}.default_tools_approval_mode`]: "approve"
    }
  };
}

function streamChunkError(part) {
  if (part?.error !== undefined) return new Error(codexErrorMessage(part.error));
  return new Error("Codex CLI 运行失败");
}

function createCodexHandler(config) {
  let abortSignal = config.abortSignal;
  return {
    getMessages: (systemPrompt, messages) => ({ systemPrompt, messages: toCodexMessages(messages) }),
    createMessage(systemPrompt, messages) {
      const responseId = `codex_${randomUUID()}`;
      const bridgeId = String(config.codex?.desicBridgeId || "");
      const run = async function* () {
        const bridge = bridges.get(bridgeId);
        if (!bridge) {
          yield { type: "done", id: responseId, success: false, error: "Codex 工具桥接已失效，请重试" };
          return;
        }
        if (!bridge.cliPath) {
          yield { type: "done", id: responseId, success: false, error: "未找到已验证的 Codex CLI 可执行文件" };
          return;
        }
        bridge.signal = abortSignal;
        let mcpServer;
        let isolatedCli;
        let lastUsage;
        try {
          isolatedCli = await createIsolatedCodexCli(bridge.cliPath);
          const localTools = bridge.tools.map((tool) => createCodexBridgeTool(bridge, tool));
          mcpServer = await createLocalMcpServer({ name: bridge.bridgeId, tools: localTools });
          const provider = createCodexExec({
            defaultSettings: codexSettings(config, bridge, mcpServer.config, isolatedCli)
          });
          const result = streamText({
            model: provider(config.modelId),
            system: systemPrompt || undefined,
            messages: toCodexMessages(messages),
            abortSignal
          });
          for await (const part of result.fullStream) {
            const mapped = mapCodexProviderPart(part, responseId);
            if (mapped) {
              yield mapped;
            } else if (part.type === "finish") {
              lastUsage = part.totalUsage || part.usage || lastUsage;
            } else if (part.type === "error") {
              throw streamChunkError(part);
            }
            // Codex executes MCP tools provider-side. Tool chunks are deliberately
            // observed through the bridge and never returned to Cline for a second execution.
          }
          lastUsage = lastUsage || await result.totalUsage;
          const usage = normalizeCodexUsage(lastUsage);
          yield { type: "usage", id: responseId, ...usage };
          yield { type: "done", id: responseId, success: true };
        } catch (error) {
          yield { type: "done", id: responseId, success: false, error: codexErrorMessage(error) };
        } finally {
          await mcpServer?.stop().catch(() => {});
          await isolatedCli?.cleanup().catch(() => {});
        }
      };
      const stream = run();
      stream.id = responseId;
      return stream;
    },
    getModel: () => ({ id: config.modelId, info: handlerModelInfo(config) }),
    abort: () => {},
    setAbortSignal: (signal) => {
      abortSignal = signal;
      const bridgeId = String(config.codex?.desicBridgeId || "");
      const bridge = bridges.get(bridgeId);
      if (bridge) bridge.signal = signal;
    }
  };
}

export function registerDesicCodexCliHandler() {
  if (registered) return;
  registered = true;
  registerAsyncHandler(CODEX_PROVIDER_ID, async (config) => createCodexHandler(config));
}
