// DES-21 真实环境端到端验收：多 Agent 后台 Run（runConfiguredProfileAgents 路径）。
//
// 与 smoke:ai-subagent / smoke:ai-10rounds 的区别：
// - 全新会话（仅一条 user 消息），不携带 initial messages，orchestration 不会被短路；
// - config 显式启用后台 Run 多 Agent Profile（backgroundRun + multiAgentMode=auto|custom，
//   含 P1 正交字段 multiAgentOrchestrator / multiAgentExpertSource）；
// - 工具宿主用真实 OKX 公共行情 REST（走系统代理）应答 toolExecuteRequest，
//   未实现的工具如实返回失败，由专家在报告中披露数据缺口。
//
// 验收断言：
// 1. profileOrchestrationStarted/Completed 事件齐全（证明走了 runConfiguredProfileAgents）；
// 2. 任何 agentDone 错误不出现「Agent 报告不是有效 JSON」「Agent 报告字段不完整」「报告状态为 partial」；
// 3. 至少一个散文式（非 JSON）专家报告被 status=done 接收（D1 宽容解析）；
// 4. profileOrchestrationCompleted.failed=0、requiredFailure=null，主 Agent 正常收尾。
//
// 用法（本机 OKX 走系统代理；NODE_USE_ENV_PROXY 必须在进程启动前设置，运行时设置无效）：
//   NODE_USE_ENV_PROXY=1 \
//   HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 \
//   NO_PROXY=localhost,127.0.0.1,api.deepseek.com \
//   node scripts/smoke-cline-sidecar-multi-agent-background.mjs
// 环境变量：
//   DESIC_MULTI_AGENT_SMOKE_MODE   auto | custom | both（默认 both）
//   DESIC_MULTI_AGENT_SMOKE_TIMEOUT_MS  单模式超时（默认 1200000）
//   DESIC_AI_API_KEY / DESIC_AI_MODEL / DESIC_AI_BASE_URL  覆盖 config/ai.local.json
// API Key 只从 config/ai.local.json 读取，绝不写入日志或事件记录。

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || "1";
process.env.HTTP_PROXY = process.env.HTTP_PROXY || process.env.http_proxy || "http://127.0.0.1:7890";
process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7890";
process.env.NO_PROXY = process.env.NO_PROXY || process.env.no_proxy || "localhost,127.0.0.1,api.deepseek.com";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const mode = (process.env.DESIC_MULTI_AGENT_SMOKE_MODE || "both").trim().toLowerCase();
const timeoutMs = Number(process.env.DESIC_MULTI_AGENT_SMOKE_TIMEOUT_MS || 1_200_000);
const BANNED_REPORT_ERRORS = /报告不是有效 JSON|报告字段不完整|状态为 partial|未返回可用报告/;

const localConfig = JSON.parse(await readFile(new URL("../config/ai.local.json", import.meta.url), "utf8"));
const deepseekEntry = (localConfig.models || []).find((m) => /api\.deepseek\.com/i.test(String(m.baseUrl || "")));
const apiKey = process.env.DESIC_AI_API_KEY || deepseekEntry?.apiKey || localConfig.apiKey || "";
const model = process.env.DESIC_AI_MODEL || deepseekEntry?.model || "deepseek-v4-pro";
let baseUrl = process.env.DESIC_AI_BASE_URL || deepseekEntry?.baseUrl || "https://api.deepseek.com";
baseUrl = baseUrl.replace(/\/+$/, "");
if (!/\/v1$/.test(baseUrl)) baseUrl += "/v1";

const missing = [];
if (!String(apiKey).trim()) missing.push("apiKey(config/ai.local.json DeepSeek entry)");
if (!String(model).trim()) missing.push("model");
if (!String(baseUrl).trim()) missing.push("baseUrl");
if (missing.length) {
  throw new Error(`AI smoke config missing ${missing.join(", ")}`);
}

const CUSTOM_AGENTS = [
  {
    id: "custom-market-structure",
    name: "市场结构（自定义）",
    role: "market_structure",
    responsibility: "检查 BTC-USDT 永续合约多周期价格结构、趋势、成交与关键失效位，明确事实与推断。",
    scopes: ["market"],
    required: true,
    enabled: true
  },
  {
    id: "custom-contrarian",
    name: "反方审查（自定义）",
    role: "contrarian",
    responsibility: "主动寻找反证、过期数据、缺失证据和不可执行假设，不重复正向结论。",
    scopes: ["market"],
    required: false,
    enabled: true
  }
];

const TASK_PROMPT = [
  "后台分析任务：请评估 BTC-USDT 永续合约当前的市场结构与短期交易风险。",
  "要求覆盖最新价格、盘口深度、逐笔成交、资金费率与持仓拥挤度，并核对资金费率基差方向。",
  "完成后汇总各专家证据，给出本轮结论、finalDecision 与下一轮观察条件；本轮不创建交易机会。"
].join("\n");

function buildConfig(modeName) {
  return {
    provider: "deepseek",
    model,
    baseUrl,
    apiKey,
    stream: true,
    agentRole: "main",
    backgroundRun: true,
    reviewRun: false,
    permissionMode: "advisor",
    reasoningDepth: "medium",
    multiAgentMode: modeName,
    multiAgentOrchestrator: "backend",
    multiAgentExpertSource: modeName,
    multiAgentMaxAgents: modeName === "custom" ? 2 : 3,
    multiAgents: modeName === "custom" ? CUSTOM_AGENTS : [],
    enableSpawnAgent: false,
    enableAgentTeams: false,
    openAgent: false,
    disableSkillsTool: true,
    enabledSkills: [],
    activeSkillIds: [],
    skillDefinitions: [],
    systemPrompt: "",
    customRules: [],
    maxIterations: 30,
    toolAllowlist: []
  };
}

// ---- 最小工具宿主：真实 OKX 公共行情 REST 子集 ----

const OKX_TOOLS = new Set([
  "market.readTicker",
  "market.readInstrument",
  "market.readOrderBook",
  "market.readRecentTrades",
  "market.readCandles",
  "market.readFundingRate"
]);

async function okxGet(path) {
  const response = await fetch(`https://www.okx.com${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OKX HTTP ${response.status}`);
  const body = await response.json();
  if (String(body.code) !== "0") throw new Error(`OKX code=${body.code} msg=${body.msg}`);
  return body.data;
}

async function executeSmokeTool(name, input) {
  const instId = String(input?.instId || "BTC-USDT-SWAP");
  switch (name) {
    case "market.readTicker": {
      const rows = await okxGet(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
      return { ...rows[0], source: "okx-public-rest-smoke", fetchedAt: Date.now() };
    }
    case "market.readInstrument": {
      const rows = await okxGet(`/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`);
      return { ...rows[0], source: "okx-public-rest-smoke" };
    }
    case "market.readOrderBook": {
      const sz = Math.min(Math.max(Number(input?.sz) || 50, 1), 400);
      const rows = await okxGet(`/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=${sz}`);
      const book = rows[0] || {};
      return {
        instId,
        asks: book.asks || [],
        bids: book.bids || [],
        ts: book.ts,
        snapshotId: `smoke-${book.ts || Date.now()}`,
        seqId: book.seqId,
        source: "okx-public-rest-smoke"
      };
    }
    case "market.readRecentTrades": {
      const limit = Math.min(Math.max(Number(input?.limit) || 50, 1), 500);
      const rows = await okxGet(`/api/v5/market/trades?instId=${encodeURIComponent(instId)}&limit=${limit}`);
      return { instId, trades: rows, source: "okx-public-rest-smoke" };
    }
    case "market.readCandles": {
      const bar = String(input?.bar || "1H");
      const limit = Math.min(Math.max(Number(input?.limit) || 100, 1), 300);
      const rows = await okxGet(`/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}&limit=${limit}`);
      return {
        instId,
        bar,
        candles: rows,
        source: "okx-public-rest-smoke",
        note: "smoke 宿主直接代理 OKX 公共 REST，无本地 SQLite 合并与 confirm 语义"
      };
    }
    case "market.readFundingRate": {
      const rows = await okxGet(`/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`);
      return { ...rows[0], source: "okx-public-rest-smoke" };
    }
    case "background.finishRun":
      return { accepted: true, smokeHost: true };
    default:
      throw new Error("smoke 工具宿主未实现该工具（仅提供 OKX 公共行情只读子集与 background.finishRun）；请改用可用工具，并在报告中披露该数据缺口");
  }
}

// ---- 单次 Run 执行与事件断言 ----

function runOnce(modeName) {
  return new Promise((resolvePromise) => {
    const sidecar = spawn(process.execPath, [resolve(root, "scripts", "cline-sidecar.mjs")], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DESIC_AI_API_KEY: apiKey }
    });

    const sessionId = `multi-agent-bg-smoke-${modeName}-${Date.now()}`;
    const transcript = [];
    const agents = new Map();
    let orchestrationStarted = null;
    let orchestrationCompleted = null;
    let finalText = "";
    let doneEvent = null;
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { sidecar.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`); } catch {}
      setTimeout(() => sidecar.kill("SIGKILL"), 500).unref();
      resolvePromise({ mode: modeName, outcome, transcript, agents, orchestrationStarted, orchestrationCompleted, finalText, doneEvent });
    };

    const timeout = setTimeout(() => {
      finish({ ok: false, reason: `timed out after ${timeoutMs}ms`, sawDone: Boolean(doneEvent) });
    }, timeoutMs);

    const send = (command) => sidecar.stdin.write(`${JSON.stringify(command)}\n`);

    readline.createInterface({ input: sidecar.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      transcript.push(event);
      if (event.type === "toolExecuteRequest") {
        const requestedAt = event.requestedAt || Date.now();
        executeSmokeTool(event.toolName, event.input).then(
          (result) => {
            send({
              type: "toolExecuteResult",
              sessionId: event.sessionId,
              executionId: event.executionId,
              ok: true,
              result,
              timing: { requestedAt, receivedAt: Date.now(), executionStartedAt: requestedAt, executionEndedAt: Date.now() }
            });
          },
          (error) => {
            send({
              type: "toolExecuteResult",
              sessionId: event.sessionId,
              executionId: event.executionId,
              ok: false,
              error: error?.message || String(error),
              timing: { requestedAt, receivedAt: Date.now(), executionStartedAt: requestedAt, executionEndedAt: Date.now() }
            });
          }
        );
        return;
      }
      if (event.type === "teamEvent" && event.event?.type === "profileOrchestrationStarted") {
        orchestrationStarted = event.event;
      }
      if (event.type === "teamEvent" && event.event?.type === "profileOrchestrationCompleted") {
        orchestrationCompleted = event.event;
      }
      if (event.type === "agentDone") {
        agents.set(event.configuredAgentId || event.agentId, {
          ...(agents.get(event.configuredAgentId || event.agentId) || {}),
          name: event.title,
          status: event.status,
          error: event.error || "",
          text: String(event.result?.text || ""),
          finishReason: event.result?.finishReason,
          successfulTools: event.result?.successfulTools || []
        });
      }
      if (event.type === "delta" && event.channel !== "reasoning") {
        finalText += event.content || "";
      }
      if (event.type === "finalText" && event.content) {
        finalText = event.content;
      }
      if (event.type === "done") {
        doneEvent = event;
        // done 之后短暂等待尾部事件落盘，再结束本轮（避免等到外层超时）。
        setTimeout(() => finish({ ok: true, reason: "done", sawDone: true }), 2_000);
      }
      if (event.type === "error") {
        transcript.push({ type: "harnessNotedError", message: event.message });
      }
    });

    readline.createInterface({ input: sidecar.stderr, crlfDelay: Infinity }).on("line", (line) => {
      transcript.push({ type: "sidecarStderr", line: String(line).slice(0, 2000) });
    });

    sidecar.on("error", (error) => finish({ ok: false, reason: `sidecar spawn failed: ${error?.message || error}` }));

    send({
      type: "sendMessage",
      sessionId,
      config: buildConfig(modeName),
      messages: [{ id: "u1", role: "user", content: TASK_PROMPT }]
    });
  });
}

function isProse(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("```")) return false;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}

function summarizeAgents(agents) {
  return Array.from(agents.values()).map((agent) => ({
    name: agent.name,
    status: agent.status,
    finishReason: agent.finishReason,
    error: agent.error,
    textLength: agent.text.length,
    textIsProse: isProse(agent.text),
    textPreview: agent.text.slice(0, 220),
    successfulTools: agent.successfulTools
  }));
}

function assertRun(run) {
  const failures = [];
  const agentList = summarizeAgents(run.agents);
  if (!run.orchestrationStarted) failures.push("缺少 profileOrchestrationStarted（未走 runConfiguredProfileAgents 路径）");
  const expectedAgents = run.mode === "custom" ? 2 : 3;
  if (run.orchestrationStarted && run.orchestrationStarted.agents?.length !== expectedAgents) {
    failures.push(`编排 Agent 数量=${run.orchestrationStarted.agents?.length}，期望 ${expectedAgents}`);
  }
  for (const agent of agentList) {
    if (BANNED_REPORT_ERRORS.test(agent.error || "")) {
      failures.push(`Agent「${agent.name}」出现被禁用的报告校验错误：${agent.error}`);
    }
  }
  const proseDone = agentList.filter((agent) => agent.status === "done" && agent.textIsProse);
  if (proseDone.length === 0) failures.push("没有散文式专家报告以 status=done 被接收（D1 宽容解析未生效）");
  if (!run.orchestrationCompleted) {
    failures.push("缺少 profileOrchestrationCompleted");
  } else {
    if (run.orchestrationCompleted.failed !== 0) failures.push(`编排完成事件 failed=${run.orchestrationCompleted.failed}`);
    if (run.orchestrationCompleted.requiredFailure) failures.push(`必需 Agent 失败：${run.orchestrationCompleted.requiredFailure}`);
    if (run.orchestrationCompleted.veto) failures.push(`出现硬否决：${run.orchestrationCompleted.veto}`);
  }
  if (!run.doneEvent) failures.push("未收到 done 事件");
  else if (String(run.doneEvent.finishReason) !== "completed") failures.push(`done finishReason=${run.doneEvent.finishReason}`);
  if (!String(run.finalText || "").trim()) failures.push("主 Agent 没有产出最终文本");
  return {
    ok: failures.length === 0,
    failures,
    report: {
      mode: run.mode,
      orchestrationStarted: run.orchestrationStarted,
      orchestrationCompleted: run.orchestrationCompleted,
      agents: agentList,
      proseDoneCount: proseDone.length,
      doneFinishReason: run.doneEvent?.finishReason || null,
      finalTextLength: run.finalText.length,
      finalTextPreview: run.finalText.trim().slice(0, 600),
      transcriptEventCount: run.transcript.length
    }
  };
}

// ---- 主流程 ----

const modes = mode === "both" ? ["auto", "custom"] : [mode];
if (!["auto", "custom"].includes(mode)) throw new Error(`DESIC_MULTI_AGENT_SMOKE_MODE 无效：${mode}`);

const artifactsDir = resolve(root, "artifacts", "des-21-multi-agent-background");
await mkdir(artifactsDir, { recursive: true });

const results = [];
for (const modeName of modes) {
  process.stdout.write(`[multi-agent-bg-smoke] starting mode=${modeName} model=${model} baseUrl=${baseUrl}\n`);
  const run = await runOnce(modeName);
  const verdict = assertRun(run);
  const transcriptPath = resolve(artifactsDir, `${modeName}-${Date.now()}.jsonl`);
  await writeFile(transcriptPath, run.transcript.map((event) => JSON.stringify(event)).join("\n"), "utf8");
  results.push({ mode: modeName, verdict, transcriptPath });
  process.stdout.write(`[multi-agent-bg-smoke] mode=${modeName} ok=${verdict.ok} transcript=${transcriptPath}\n`);
  if (!verdict.ok) {
    process.stdout.write(`[multi-agent-bg-smoke] failures: ${JSON.stringify(verdict.failures, null, 2)}\n`);
  }
  process.stdout.write(`[multi-agent-bg-smoke] report: ${JSON.stringify(verdict.report, null, 2)}\n`);
}

const allOk = results.every((result) => result.verdict.ok);
process.stdout.write(`[multi-agent-bg-smoke] ${allOk ? "PASS" : "FAIL"} modes=${modes.join(",")}\n`);
process.exit(allOk ? 0 : 1);
