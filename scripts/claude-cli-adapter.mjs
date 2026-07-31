import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { registerAsyncHandler } from "@cline/llms";
import { createLocalMcpServer } from "ai-sdk-provider-codex-cli";
import { createCodexBridgeTool, toCodexMessages } from "./codex-cli-adapter.mjs";

const CLAUDE_PROVIDER_ID = "claude-code";
const bridges = new Map();
const sessionBridgeIds = new Map();
let registered = false;

function sanitizeClaudeErrorDetail(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "[API key redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/\s*\r?\n+\s*/g, "; ")
    .trim()
    .slice(0, 2_000);
}

export function claudeErrorMessage(value, stderr = "") {
  const detail = sanitizeClaudeErrorDetail(value);
  const stderrDetail = sanitizeClaudeErrorDetail(stderr);
  const combined = [detail, stderrDetail]
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(": ");
  const lower = combined.toLowerCase();
  if (lower.includes("403") && lower.includes("request not allowed")) {
    return "Claude Code 返回 403 Request not allowed；请确认终端中的 claude -p 可正常运行，并检查用户级 Claude 路由、代理与账号权限";
  }
  if (lower.includes("failed to authenticate")) {
    return `Claude Code 认证失败${combined ? `：${combined}` : ""}`;
  }
  return combined || "Claude Code CLI 运行失败";
}

export function toClaudePrompt(messages = []) {
  const normalized = toCodexMessages(messages);
  if (normalized.length === 0) return "请根据系统要求完成当前任务。";
  return [
    "以下是当前对话记录。请继续完成最后一条用户请求。",
    "",
    ...normalized.map((message) => (
      `${message.role === "assistant" ? "ASSISTANT" : "USER"}:\n${message.content}`
    ))
  ].join("\n\n");
}

function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

export function normalizeClaudeUsage(usage = {}) {
  return {
    inputTokens: tokenCount(usage.input_tokens ?? usage.inputTokens),
    outputTokens: tokenCount(usage.output_tokens ?? usage.outputTokens),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
    thoughtsTokenCount: tokenCount(usage.thinking_tokens ?? usage.thoughtsTokenCount)
  };
}

export function mapClaudeStreamEvent(event, responseId) {
  if (event?.type !== "stream_event") return null;
  const delta = event.event?.delta;
  if (delta?.type === "text_delta" && delta.text) {
    return { type: "text", id: responseId, text: delta.text };
  }
  if (delta?.type === "thinking_delta" && delta.thinking) {
    return { type: "reasoning", id: responseId, reasoning: delta.thinking };
  }
  return null;
}

function registerSessionBridge(sessionId, bridgeId) {
  const ids = sessionBridgeIds.get(sessionId) || new Set();
  ids.add(bridgeId);
  sessionBridgeIds.set(sessionId, ids);
}

export function registerClaudeToolBridge(options) {
  const bridgeId = `claude_bridge_${randomUUID().replaceAll("-", "")}`;
  const tools = Array.isArray(options.tools)
    ? options.tools.filter((tool) => tool?.name && tool?.execute)
    : [];
  bridges.set(bridgeId, {
    ...options,
    bridgeId,
    providerId: CLAUDE_PROVIDER_ID,
    toolCallPrefix: "claude",
    tools
  });
  registerSessionBridge(options.sessionId, bridgeId);
  return bridgeId;
}

export function cleanupClaudeToolBridges(sessionId) {
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
    maxTokens: 32_000,
    supportsImages: false,
    supportsPromptCache: true
  };
  return config.modelInfo ?? config.knownModels?.[config.modelId] ?? fallback;
}

function validModelId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
}

function claudeEffort(value) {
  if (["medium", "high", "xhigh", "max"].includes(value)) return value;
  return "low";
}

function claudeMaxTurns(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 128) : 50;
}

async function createClaudeRunFiles(systemPrompt, serverName, serverConfig) {
  const directory = await mkdtemp(join(tmpdir(), "desic-claude-cli-"));
  const mcpPath = join(directory, "mcp.json");
  const systemPromptPath = join(directory, "system-prompt.txt");
  const mcpConfig = {
    mcpServers: {
      [serverName]: {
        type: "http",
        url: serverConfig.url,
        headers: {
          Authorization: `Bearer ${serverConfig.bearerToken}`
        },
        alwaysLoad: true
      }
    }
  };
  try {
    await Promise.all([
      writeFile(mcpPath, JSON.stringify(mcpConfig), { encoding: "utf8", mode: 0o600 }),
      writeFile(systemPromptPath, systemPrompt || "You are the Desic Terminal AI assistant.", {
        encoding: "utf8",
        mode: 0o600
      })
    ]);
    return {
      mcpPath,
      systemPromptPath,
      cleanup: () => rm(directory, { force: true, recursive: true })
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
}

function claudeEnvironment() {
  const env = {
    ...process.env,
    CLAUDE_CODE_SIMPLE: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    DISABLE_AUTOUPDATER: "1",
    MCP_TIMEOUT: "10000",
    MCP_TOOL_TIMEOUT: "120000"
  };
  // The desktop app may itself be launched from a Claude Code shell. The child is
  // an intentional isolated invocation, not a nested interactive Claude session.
  delete env.CLAUDECODE;
  return env;
}

function spawnClaude(cliPath, args, options) {
  const javascriptCli = /\.(?:c|m)?js$/i.test(cliPath);
  if (javascriptCli) {
    return spawn(process.execPath, [cliPath, ...args], options);
  }
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cliPath)) {
    return spawn(cliPath, args, { ...options, shell: true });
  }
  return spawn(cliPath, args, options);
}

function createClaudeArgs(config, bridge, runFiles) {
  const model = String(config.modelId || "").trim();
  if (!validModelId(model)) throw new Error("Claude Code Model ID 含有不支持的字符");
  const allowedTools = bridge.tools.map((tool) => `mcp__${bridge.bridgeId}__${tool.name}`);
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", model,
    "--effort", claudeEffort(bridge.reasoningEffort),
    "--permission-mode", "dontAsk",
    "--max-turns", String(claudeMaxTurns(bridge.maxTurns)),
    // User settings may carry the user's ANTHROPIC_BASE_URL/AUTH_TOKEN route.
    // Command-line isolation below disables hooks, memories, skills and all native tools.
    "--setting-sources", "user",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config",
    "--mcp-config", runFiles.mcpPath,
    "--tools", "",
    ...(allowedTools.length > 0 ? ["--allowedTools", allowedTools.join(",")] : []),
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt-file", runFiles.systemPromptPath
  ];
}

function createClaudeHandler(config) {
  let abortSignal = config.abortSignal;
  return {
    getMessages: (systemPrompt, messages) => ({ systemPrompt, messages }),
    createMessage(systemPrompt, messages) {
      const responseId = `claude_${randomUUID()}`;
      const bridgeId = String(config.claudeCode?.desicBridgeId || "");
      const run = async function* () {
        const bridge = bridges.get(bridgeId);
        if (!bridge) {
          yield { type: "done", id: responseId, success: false, error: "Claude Code 工具桥接已失效，请重试" };
          return;
        }
        if (!bridge.cliPath) {
          yield { type: "done", id: responseId, success: false, error: "未找到已验证的 Claude Code CLI 可执行文件" };
          return;
        }
        bridge.signal = abortSignal;
        let mcpServer;
        let runFiles;
        let child;
        let abortTimer;
        let abortHandler;
        let spawnError;
        let stderr = "";
        let resultEvent;
        try {
          const localTools = bridge.tools.map((tool) => createCodexBridgeTool(bridge, tool));
          mcpServer = await createLocalMcpServer({ name: bridge.bridgeId, tools: localTools });
          runFiles = await createClaudeRunFiles(systemPrompt, bridge.bridgeId, mcpServer.config);
          const args = createClaudeArgs(config, bridge, runFiles);
          child = spawnClaude(bridge.cliPath, args, {
            cwd: bridge.cwd,
            env: claudeEnvironment(),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true
          });
          child.on("error", (error) => {
            spawnError = error;
          });
          const closePromise = new Promise((resolve) => {
            child.once("close", (code, signal) => resolve({ code, signal }));
          });
          child.stderr.on("data", (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-20_000);
          });
          abortHandler = () => {
            child?.kill("SIGTERM");
            abortTimer = setTimeout(() => child?.kill("SIGKILL"), 2_000);
            abortTimer.unref?.();
          };
          if (abortSignal?.aborted) abortHandler();
          else abortSignal?.addEventListener("abort", abortHandler, { once: true });
          child.stdin.on("error", () => {});
          child.stdin.end(toClaudePrompt(messages));
          const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
          for await (const line of lines) {
            if (!line.trim()) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            const mapped = mapClaudeStreamEvent(event, responseId);
            if (mapped) yield mapped;
            if (event.type === "result") resultEvent = event;
          }
          const exit = await closePromise;
          abortSignal?.removeEventListener("abort", abortHandler);
          if (abortSignal?.aborted) {
            yield { type: "done", id: responseId, success: false, error: "Claude Code 请求已取消" };
            return;
          }
          if (spawnError) throw spawnError;
          if (resultEvent?.is_error || resultEvent?.subtype !== "success" || exit.code !== 0) {
            const resultError = resultEvent?.result || `Claude Code CLI exited with code ${exit.code ?? "unknown"}`;
            yield {
              type: "done",
              id: responseId,
              success: false,
              error: claudeErrorMessage(resultError, stderr)
            };
            return;
          }
          const usage = normalizeClaudeUsage(resultEvent?.usage);
          yield { type: "usage", id: responseId, ...usage };
          yield { type: "done", id: responseId, success: true };
        } catch (error) {
          yield {
            type: "done",
            id: responseId,
            success: false,
            error: claudeErrorMessage(error?.message || String(error), stderr)
          };
        } finally {
          if (abortHandler) abortSignal?.removeEventListener("abort", abortHandler);
          if (abortTimer) clearTimeout(abortTimer);
          if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          await mcpServer?.stop().catch(() => {});
          await runFiles?.cleanup().catch(() => {});
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
      const bridgeId = String(config.claudeCode?.desicBridgeId || "");
      const bridge = bridges.get(bridgeId);
      if (bridge) bridge.signal = signal;
    }
  };
}

export function registerDesicClaudeCliHandler() {
  if (registered) return;
  registered = true;
  registerAsyncHandler(CLAUDE_PROVIDER_ID, async (config) => createClaudeHandler(config));
}
