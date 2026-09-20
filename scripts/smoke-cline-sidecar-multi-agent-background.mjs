// v3 §4 真实环境端到端验收：主 Agent 点名调度（consult_expert → 专家报告原样回流）。
//
// 与 smoke:ai-subagent / smoke:ai-10rounds 的区别：
// - 全新会话（仅一条 user 消息），config 用勾选制 `enabledAgents`（无 multiAgents /
//   multiAgentMode / multiAgentOrchestrator —— 这些字段与 backend 编排器一起删除）；
// - 工具宿主用真实 OKX 公共行情 REST（走系统代理）应答 toolExecuteRequest，
//   未实现的工具如实返回失败，由专家在报告中披露数据缺口。
//
// 验收断言（v3 语义）：
// 1. **无后端预跑**：transcript 里不得出现 profileOrchestrationStarted/Completed，
//    也不得在 cline.start 之前出现任何 agentStart（专家由主 Agent 中途点名）；
// 2. 主 Agent 确实点名：出现 consult_expert 工具调用与对应 toolResult；
// 3. 专家会话按名单启动：agentStart/agentDone 的 configuredAgentId ∈ enabledAgents；
// 4. **报告原样回流**：consult_expert 返回的 report = `信封 + "\n" + 正文`，其中正文必须
//    **逐字等于**该专家本轮 agentDone 的全文（按后缀比对，不做任何截断/改写/追加；
//    旧 12k 字符 / 4k token 预算已删除）；
// 5. 主 Agent 正常收尾（done finishReason=completed）且没有报告被判定为
//    「不是有效 JSON / 字段不完整 / 状态为 partial」。
//
// 用法（本机 OKX 走系统代理；NODE_USE_ENV_PROXY 必须在进程启动前设置，运行时设置无效）：
//   NODE_USE_ENV_PROXY=1 \
//   HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 \
//   NO_PROXY=localhost,127.0.0.1,api.deepseek.com \
//   node scripts/smoke-cline-sidecar-multi-agent-background.mjs
// 环境变量：
//   DESIC_MULTI_AGENT_SMOKE_TIMEOUT_MS  单次超时（默认 1800000）
//   DESIC_AI_API_KEY / DESIC_AI_MODEL / DESIC_AI_BASE_URL  覆盖 config/ai.local.json
//
// 离线重放（不需要模型与网络，用于回归历史误报）：
//   node scripts/smoke-cline-sidecar-multi-agent-background.mjs --replay <transcript.jsonl>
//   仓库内固定夹具：scripts/fixtures/cline-agent-dispatch-followup-transcript.jsonl
//   （取自真实运行 run-1789748335844：批量 2 位 parallel + 随后各一次 follow_up。
//   旧断言按"最后一轮"取窗口，会算出 overlapMs=-10 误报；本夹具锁死该形态。）
//
// 断言要点（C18）：批次重叠只看该次 consult_experts 自己窗口内的轮次；serial 是屏障；
// follow_up 单独断言（调用与返回都要正常，但不参与批次重叠）；报告原样回流按"信封前缀 +
// 正文后缀"匹配（后缀比对，见 §6 注释）。
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
const timeoutMs = Number(process.env.DESIC_MULTI_AGENT_SMOKE_TIMEOUT_MS || 1_800_000);
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

// 预检工具宿主的行情出口。OKX 在本机只能走代理，而 NODE_USE_ENV_PROXY 必须在**进程启动前**
// 设置（脚本内赋值对已创建的 undici 全局 agent 无效）。出口不可达时，专家会拿到一堆
// "fetch failed"，验收结论会被误读成调度问题——所以先探测并给出明确指引。
async function preflightMarketEgress() {
  try {
    const rows = await okxGet("/api/v5/market/ticker?instId=BTC-USDT-SWAP");
    return String(rows?.[0]?.last || "") ? "" : "OKX 返回空 ticker";
  } catch (error) {
    return error?.message || String(error);
  }
}

// 勾选名单 = 本次可点名专家。body 即该专家的系统提示词主体（固定外壳由侧车前置拼接）。
// C15：Agent 载荷不再有 scopes —— 只读工具面由主 Agent 点名时决定（不传 = 全部只读工具）。
const ENABLED_AGENTS = [
  {
    id: "custom-market-structure",
    name: "市场结构（自定义）",
    role: "market_structure",
    envelope: "standard",
    skills: [],
    requiresAccount: false,
    source: "custom",
    version: 1,
    summary: "检查 BTC-USDT 永续合约多周期价格结构、趋势、成交与关键失效位，明确事实与推断。",
    body: [
      "## 身份",
      "只读「市场结构」专家，仅读行情类证据，不决策、不下单。",
      "",
      "## 职责",
      "检查 BTC-USDT 永续合约多周期价格结构、趋势、成交量与关键失效位，区分事实与推断。",
      "",
      "## 方法与证据要求",
      "读取最新价格、K 线与资金费率，记录工具返回的观测时间与记录 ID；不同快照只描述为随时间变化。",
      "",
      "## 输出偏好",
      "Markdown 或散文自由撰写：先给结构判断与依据，再给关键价位与数据缺口；不必输出 JSON。",
      "",
      "## 数据缺口处理",
      "缺少某周期证据时只报告已有周期，并写明缺口；样本不足时不外推结论。"
    ].join("\n")
  },
  {
    id: "custom-order-flow",
    name: "订单流（自定义）",
    role: "order_flow_liquidity",
    envelope: "standard",
    skills: [],
    requiresAccount: false,
    source: "custom",
    version: 1,
    summary: "检查盘口深度、买卖价差与逐笔成交，识别短时冲击与滑点风险。",
    body: [
      "## 身份",
      "只读「订单流」专家，仅读盘口与成交类证据。",
      "",
      "## 职责",
      "检查盘口深度、买卖价差、逐笔成交与流动性缺口，识别短时冲击与滑点风险。",
      "",
      "## 方法与证据要求",
      "盘口证据必须记录 snapshotId/seqId 与观测时间；主动买卖方向以工具返回口径为准。",
      "",
      "## 输出偏好",
      "Markdown 或散文自由撰写：先给流动性判断与依据，再给缺口与样本量。",
      "",
      "## 数据缺口处理",
      "缺逐笔或盘口证据时写明无法量化冲击成本，不用单快照代表持续状态。"
    ].join("\n")
  }
];

const TASK_PROMPT = [
  "后台分析任务：请评估 BTC-USDT 永续合约当前的市场结构与短期交易风险。",
  "你需要自己判断要点名哪些专家：按名单里的 id 点名，至少点名一位（可用 consult_expert 或 consult_experts）。",
  "完成后汇总各专家证据，给出本轮结论、finalDecision 与下一轮观察条件；本轮不创建交易机会。"
].join("\n");

function buildConfig() {
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
    // v3 勾选制载荷（C4）：只保留 enabledAgents，旧 multiAgent* 字段一律不再发送。
    enabledAgents: ENABLED_AGENTS,
    // C27：侧车把这个载荷的 Profile 事实原样注入每位专家的任务前缀（5 行事实块）。
    // 本烟测是 `lib.rs` 载荷的手写镜像，必须与那里保持同样的键，否则烟测永远
    // 跑不到事实块的真实取值（旧版只发 accountId，等于事实块恒为"未提供"）。
    // 用明显的占位值：不接真实账户、不触发任何写入。
    agentProfileAccountId: "ACCOUNT_ID_PLACEHOLDER",
    agentProfileEnvironment: "demo",
    agentProfileTargetLeverage: 20,
    agentProfileMaxSingleTradeMarginPct: 30,
    agentProfileSymbols: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
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

// ---- 事件采集（实时运行与离线重放共用同一套逻辑）----
//
// C18 数据结构要点：每位专家按**轮**记录（agentStart 开一条、agentDone 补 end/text）。
// 覆盖式槽位会把"批量那一轮"和"follow_up 那一轮"混在一起，导致批次重叠断言误报
// （真实运行 artifacts/agent-dispatch-background/run-1789748335844.jsonl：算出 overlapMs=-10，
// 而批次本身是并行的：order-flow 在 market-structure 开始 215ms 后启动）。
function createRunCollector() {
  const transcript = [];
  const agentRuns = new Map();
  const consultResults = [];
  const consultCalls = [];
  const consultCallsByToolCallId = new Map();
  let orchestrationEvent = null;
  let finalText = "";
  let doneEvent = null;

  const ensureAgentEntry = (id) => agentRuns.get(id) || {
    id,
    name: id,
    status: "running",
    tools: [],
    runs: [],
    text: "",
    error: "",
    finishReason: null,
    startedAt: null,
    endedAt: null
  };

  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    // 采集/重放两侧的旁注（宿主记的错误、sidecar stderr）只落进 transcript，不参与断言。
    if (event.type === "harnessNotedError" || event.type === "sidecarStderr") {
      transcript.push(event);
      return false;
    }
    transcript.push(event);
    if (event.type === "teamEvent" && /profileOrchestration/.test(String(event.event?.type || ""))) {
      orchestrationEvent = event.event;
    }
    // C18：调度工具四件套 —— consult_expert（单个）/ consult_experts（批量）/ follow_up / team_status。
    // 批量结果形状是 { ok, results: [...], failures: [...] }，这里摊平成逐专家条目，
    // "报告原样回流 / grantedScopes"断言对两种形状一视同仁。
    // 调用时刻/返回时刻一律取事件自带时间戳（与 agentStart/agentDone 同一时钟），
    // 这样离线重放录制 transcript 时窗口匹配依然成立。
    const isConsultCall = event.type === "toolCall"
      && (event.name === "consult_expert" || event.name === "consult_experts" || event.name === "follow_up");
    if (isConsultCall) {
      const call = {
        at: Number(event.startedAt) || Date.now(),
        toolCallId: event.toolCallId,
        name: event.name,
        arguments: event.arguments,
        resultAt: null,
        ok: null
      };
      consultCalls.push(call);
      consultCallsByToolCallId.set(event.toolCallId, call);
    }
    if (event.type === "toolResult"
      && (event.name === "consult_expert" || event.name === "consult_experts" || event.name === "follow_up")) {
      const call = consultCallsByToolCallId.get(event.toolCallId);
      if (call) {
        call.resultAt = Number(event.endedAt) || Date.now();
        call.ok = event.ok !== false;
      }
      if ((event.name === "consult_expert" || event.name === "consult_experts") && event.ok !== false) {
        const payload = event.result || {};
        const items = Array.isArray(payload.results) ? payload.results : [payload];
        for (const item of items) {
          consultResults.push({
            at: Number(event.endedAt) || Date.now(),
            toolCallId: event.toolCallId,
            name: event.name,
            batch: Array.isArray(payload.results),
            result: item
          });
        }
      }
    }
    if (event.type === "toolCall") {
      // 记录主 Agent 与专家各自的工具调用来源（configuredAgentId 只在本轮专家会话上出现）。
      if (event.configuredAgentId || event.agentId) {
        const key = event.configuredAgentId || event.agentId;
        const entry = ensureAgentEntry(key);
        entry.tools.push(event.name);
        agentRuns.set(key, entry);
      }
    }
    if (event.type === "agentStart" && event.configuredAgentId) {
      const entry = ensureAgentEntry(event.configuredAgentId);
      // 每次 agentStart 开一条新轮次；同一专家的多轮（批量 + follow_up）各自独立。
      entry.runs.push({
        start: Number(event.startedAt) || Date.now(),
        end: null,
        text: "",
        finishReason: null,
        task: event.task || ""
      });
      entry.name = event.title || entry.name;
      entry.startedAt = entry.runs[0].start;
      agentRuns.set(event.configuredAgentId, entry);
    }
    if (event.type === "agentDone") {
      const key = event.configuredAgentId || event.agentId;
      const entry = ensureAgentEntry(key);
      const openRun = [...entry.runs].reverse().find((item) => item.end === null);
      const text = String(event.result?.text || "");
      const end = Number(event.endedAt) || Date.now();
      if (openRun) {
        openRun.end = end;
        openRun.text = text;
        openRun.finishReason = event.result?.finishReason;
      } else {
        // 没有对应的 agentStart（异常路径）：仍记一条，避免时间线丢轮次。
        entry.runs.push({ start: end, end, text, finishReason: event.result?.finishReason, task: "" });
      }
      entry.name = event.title || entry.name;
      entry.status = event.status;
      entry.error = event.error || "";
      entry.text = text;
      entry.finishReason = event.result?.finishReason;
      entry.successfulTools = event.result?.successfulTools || [];
      entry.endedAt = end;
      agentRuns.set(key, entry);
    }
    // 只认 text-final（text-preview 是逐字累积预览，累加会得到重复文本）。
    if (event.type === "delta" && event.channel === "text-final" && event.content) {
      finalText = event.content;
    }
    if (event.type === "finalText" && event.content) {
      finalText = event.content;
    }
    if (event.type === "done") {
      doneEvent = event;
      return true;
    }
    return false;
  };

  return {
    handleEvent,
    /// 与旧 runOnce 返回值保持同形，assertRun 无需感知采集方式。
    snapshot: (outcome) => ({
      outcome,
      transcript,
      agentRuns,
      consultResults,
      consultCalls,
      orchestrationEvent,
      finalText,
      doneEvent
    })
  };
}

// ---- 单次 Run 执行 ----

function runOnce() {
  return new Promise((resolvePromise) => {
    const sidecar = spawn(process.execPath, [resolve(root, "scripts", "cline-sidecar.mjs")], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DESIC_AI_API_KEY: apiKey }
    });

    const sessionId = `agent-dispatch-bg-smoke-${Date.now()}`;
    const collector = createRunCollector();
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { sidecar.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`); } catch {}
      setTimeout(() => sidecar.kill("SIGKILL"), 500).unref();
      resolvePromise(collector.snapshot(outcome));
    };

    const timeout = setTimeout(() => {
      finish({ ok: false, reason: `timed out after ${timeoutMs}ms`, sawDone: Boolean(collector.snapshot().doneEvent) });
    }, timeoutMs);

    const send = (command) => sidecar.stdin.write(`${JSON.stringify(command)}\n`);

    readline.createInterface({ input: sidecar.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "toolExecuteRequest") {
        collector.handleEvent(event);
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
      const finished = collector.handleEvent(event);
      if (event.type === "error") {
        collector.handleEvent({ type: "harnessNotedError", message: event.message });
      }
      if (finished) {
        // done 之后短暂等待尾部事件落盘，再结束本轮（避免等到外层超时）。
        setTimeout(() => finish({ ok: true, reason: "done", sawDone: true }), 2_000);
      }
    });

    readline.createInterface({ input: sidecar.stderr, crlfDelay: Infinity }).on("line", (line) => {
      collector.handleEvent({ type: "sidecarStderr", line: String(line).slice(0, 2000) });
    });

    sidecar.on("error", (error) => finish({ ok: false, reason: `sidecar spawn failed: ${error?.message || error}` }));

    send({
      type: "sendMessage",
      sessionId,
      config: buildConfig(),
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

function summarizeAgents(agentRuns) {
  return Array.from(agentRuns.values()).map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    finishReason: agent.finishReason,
    error: agent.error,
    toolCount: (agent.tools || []).length,
    runCount: (agent.runs || []).length,
    runs: (agent.runs || []).map((run) => ({
      start: run.start,
      end: run.end,
      durationMs: run.end ? run.end - run.start : null,
      textLength: String(run.text || "").length
    })),
    successfulTools: agent.successfulTools || [],
    textLength: String(agent.text || "").length,
    textIsProse: isProse(agent.text),
    textPreview: String(agent.text || "").slice(0, 220)
  }));
}

/// C18 断言核心：把"调用窗口 → 该窗口内的轮次"配对起来。
/// 关键点：批次重叠只看**该次 consult_experts 自己的窗口**内的轮次；follow_up 会为同一专家
/// 再开一轮，若按"最后一轮"取窗口就会把批次与追问混在一起（真实运行 run-1789748335844
/// 的误报根因：算出 overlapMs=-10）。
function runsInWindow(agent, windowStart, windowEnd) {
  if (!agent) return [];
  return (agent.runs || []).filter((run) => {
    const runEnd = run.end ?? Number.POSITIVE_INFINITY;
    return run.start < windowEnd && runEnd > windowStart;
  });
}

function windowOverlapMs(left, right) {
  return Math.min(left.end, right.end) - Math.max(left.start, right.start);
}

function assertRun(run) {
  const failures = [];
  const enabledIds = ENABLED_AGENTS.map((agent) => agent.id);
  const agents = summarizeAgents(run.agentRuns).filter((agent) => enabledIds.includes(agent.id));
  const agentById = (id) => run.agentRuns.get(id);
  const callsById = new Map(run.consultCalls.map((call) => [call.toolCallId, call]));
  const resultsByCall = new Map();
  for (const entry of run.consultResults) {
    const list = resultsByCall.get(entry.toolCallId) || [];
    list.push(entry);
    resultsByCall.set(entry.toolCallId, list);
  }
  // 调用窗口：[toolCall 时刻, toolResult 时刻]（缺 resultAt 时退化为该专家的最早轮次起点）
  const callWindow = (call) => ({
    start: call.at,
    end: call.resultAt || call.at + 1
  });

  // 1. 无后端预跑
  if (run.orchestrationEvent) {
    failures.push(`后端预跑波仍存在：${JSON.stringify(run.orchestrationEvent)}`);
  }

  // 2. 主 Agent 点名
  if (run.consultCalls.length === 0) failures.push("主 Agent 没有点名任何专家（consult_expert / consult_experts 均未调用）");
  if (run.consultResults.length === 0) failures.push("点名工具没有成功返回（专家报告未回流）");
  const unknownExpert = run.consultResults.filter((entry) => entry.result?.errorCode === "unknown_expert");
  if (unknownExpert.length > 0) failures.push(`点评名了名单外的专家：${JSON.stringify(unknownExpert.slice(0, 2))}`);

  // 3. 专家会话按名单启动（状态取最后一轮）
  if (agents.length === 0) failures.push("没有任何 enabledAgents 名单内的专家会话被启动");
  for (const agent of agents) {
    if (agent.status !== "done") failures.push(`专家「${agent.name || agent.id}」状态=${agent.status}：${agent.error}`);
  }

  // 4. grantedScopes：非空且 ⊆ 白名单（主 Agent 有权收窄，合法收窄不得判失败）。
  const SCOPE_WHITELIST = ["market", "derivatives", "intelligence", "account", "history"];
  for (const entry of run.consultResults) {
    const granted = entry.result?.grantedScopes;
    if (!Array.isArray(granted) || granted.length === 0
      || granted.some((scope) => !SCOPE_WHITELIST.includes(scope))) {
      failures.push(`点名返回值缺少合法的 grantedScopes（应为白名单子集）：${JSON.stringify(granted)}`);
    }
  }

  // 5. C18.4：批量点名必须真的并行 —— 只看该批次自己窗口内的轮次。
  //    并行专家（mode 缺省即 parallel）之间必须重叠；serial 是屏障，与同批次其它轮次都不重叠。
  const parallelWindows = [];
  const serialBarriers = [];
  for (const call of run.consultCalls.filter((entry) => Array.isArray(entry.arguments?.experts))) {
    if (!call.resultAt) {
      failures.push(`consult_experts 没有 toolResult（无法校验批次窗口）：${call.toolCallId}`);
      continue;
    }
    const window = callWindow(call);
    const picked = [];
    for (const item of call.arguments.experts) {
      const expertId = String(item?.expertId || "");
      const mode = String(item?.mode || "parallel") === "serial" ? "serial" : "parallel";
      const rounds = runsInWindow(agentById(expertId), window.start, window.end)
        .map((round) => ({ expertId, mode, start: round.start, end: round.end ?? window.end }));
      if (rounds.length === 0) {
        failures.push(`批次里的专家「${expertId}」在该批次窗口内没有任何轮次：${JSON.stringify(window)}`);
        continue;
      }
      // 同一批次内同一专家可能有多条重叠轮次（异常）；取最早开始的一条为准。
      rounds.sort((left, right) => left.start - right.start);
      picked.push(rounds[0]);
    }
    const parallelPicked = picked.filter((item) => item.mode !== "serial");
    if (parallelPicked.length >= 2) {
      const overlapMs = Math.min(...parallelPicked.map((item) => item.end)) - Math.max(...parallelPicked.map((item) => item.start));
      parallelWindows.push({
        toolCallId: call.toolCallId,
        experts: parallelPicked.map((item) => item.expertId),
        overlapMs,
        windows: parallelPicked.map((item) => ({ expertId: item.expertId, start: item.start, end: item.end }))
      });
      if (overlapMs <= 0) {
        failures.push(`consult_experts 的并行专家没有时间重叠（overlapMs=${overlapMs}）：${JSON.stringify(parallelPicked)}`);
      }
    }
    for (const serial of picked.filter((item) => item.mode === "serial")) {
      const others = picked.filter((item) => item.expertId !== serial.expertId && item.mode !== "serial");
      const collisions = others.filter((other) => windowOverlapMs(serial, other) > 0);
      serialBarriers.push({
        toolCallId: call.toolCallId,
        expertId: serial.expertId,
        overlaps: collisions.map((item) => item.expertId),
        gapToPreviousBatchMs: others.length > 0
          ? serial.start - Math.max(...others.map((item) => item.end))
          : null
      });
      if (collisions.length > 0) {
        failures.push(`serial 专家「${serial.expertId}」与同批次并行轮次重叠（屏障失效）：${JSON.stringify(collisions)}`);
      }
    }
  }

  // 6. 报告原样回流（多轮感知）：consult 类返回的 `report` = `信封 + "\n" + 该专家那一轮的正文`
  //    （信封见 cline-sidecar.mjs `deliverExpertReport`：一行"…（不可信证据：…）："），
  //    因此**逐字包含**只可能落在正文这一侧，比对必须按"信封前缀 + 正文后缀"来做。
  //    （tsk_625ecd6a 修正：旧断言用 `report.includes(round.text)` 做全文串匹配 —— report 前面已经
  //    多出信封，全文串匹配在信封存在时原理上不成立，实测差值恒等于"信封长 − 1"；它偶尔"通过"
  //    只是恰好命中了同窗口内的另一轮，属脆弱断言。改成后缀比对后判据更强：既不截断、也不改写、
  //    更不允许在正文之后追加任何东西。）
  const REPORT_ENVELOPE_HEAD = "（不可信证据：";
  for (const entry of run.consultResults) {
    const expertId = String(entry.result?.expertId || "");
    const agent = agentById(expertId);
    if (!agent) continue;
    const report = String(entry.result?.report || "");
    // 信封必须在位（安全判据：主 Agent 要能看见"这是不可信证据"）。这里只认标记本身，
    // 不锁死信封措辞，避免与文案迭代互锁。
    if (!report.includes(REPORT_ENVELOPE_HEAD)) {
      failures.push(`专家「${agent.name || expertId}」的回流报告缺少"不可信证据"信封前缀`);
    }
    const call = callsById.get(entry.toolCallId);
    if (!call) continue;
    const window = callWindow(call);
    const rounds = runsInWindow(agent, window.start, window.end);
    const suffixMatched = (round) => {
      const text = String(round?.text || "");
      return text.length > 0 && report.endsWith(text);
    };
    const matched = rounds.filter(suffixMatched);
    if (matched.length === 0) {
      const anyRound = (agent.runs || []).filter(suffixMatched);
      const bestRound = rounds
        .map((round) => String(round.text || ""))
        .concat((agent.runs || []).map((round) => String(round.text || "")))
        .reduce((longest, text) => (text.length > longest.length ? text : longest), "");
      // 后缀差 = report 尾部中"不属于该轮正文"的长度；装配正确时它应恰等于信封长 − 1。
      const tailDelta = bestRound && report.includes(bestRound) ? report.length - bestRound.length : null;
      failures.push(
        `专家「${agent.name || expertId}」本轮报告没有被原样回流（后缀匹配=0，任意轮后缀匹配=${anyRound.length}，`
        + `轮次数=${rounds.length}，报告长度=${report.length}，最长轮次正文=${bestRound.length}`
        + `${tailDelta === null ? "" : `，非正文尾部差=${tailDelta}`}）`
      );
    } else if (matched.length > 1) {
      // 同一窗口内两轮正文都能对上：窗口切分本身可疑（正常应恰好一轮），如实抛出。
      failures.push(
        `专家「${agent.name || expertId}」本轮窗口内有 ${matched.length} 轮正文同时匹配报告后缀（窗口切分可疑）`
      );
    }
    if (/已截断|中段省略/.test(report)) {
      failures.push(`回流报告仍带截断标注：${expertId}`);
    }
  }
  // 7. follow_up 单独断言（不参与批次重叠）：调用与返回都要正常，且确实为该专家开了一轮。
  const followUps = [];
  for (const call of run.consultCalls.filter((entry) => entry.name === "follow_up")) {
    const expertId = String(call.arguments?.expertId || "");
    const entry = { expertId, toolCallId: call.toolCallId, ok: call.ok === true };
    if (!call.resultAt) {
      failures.push(`follow_up 没有返回（${expertId}）：${call.toolCallId}`);
    } else if (call.ok !== true) {
      const item = (resultsByCall.get(call.toolCallId) || [])[0];
      failures.push(`follow_up 返回失败（${expertId}）：${JSON.stringify(item?.result?.summary || "")}`);
    }
    const window = callWindow(call);
    const rounds = runsInWindow(agentById(expertId), window.start, window.end);
    entry.rounds = rounds.length;
    if (call.resultAt && rounds.length === 0) {
      failures.push(`follow_up 声称完成了（${expertId}），但该窗口内没有任何专家轮次：${JSON.stringify(window)}`);
    }
    followUps.push(entry);
  }

  for (const agent of agents) {
    if (BANNED_REPORT_ERRORS.test(agent.error || "")) {
      failures.push(`专家「${agent.name}」出现被禁用的报告校验错误：${agent.error}`);
    }
  }

  // 8. 主 Agent 收尾。注意：以 background.finishRun 收尾时，ClineCore 的 start() 会返回
  // finishReason=error，且错误消息就是助手自己的最终文本（侧车既有的
  // `finishReason === "error"` 兜底把它当 errorMessage 上报）。这是 provider/SDK 终态
  // 映射的既有现象，与调度改造无关，因此这里只要求「到达终态且主 Agent 产出了最终文本」，
  // 原始 finishReason 会原样写进报告供复核。
  if (!run.doneEvent) {
    failures.push("未收到 done 事件");
  } else if (!["completed", "error"].includes(String(run.doneEvent.finishReason))) {
    failures.push(`done finishReason=${run.doneEvent.finishReason}`);
  }
  if (!String(run.finalText || "").trim()) failures.push("主 Agent 没有产出最终文本");

  return {
    ok: failures.length === 0,
    failures,
    report: {
      consultCalls: run.consultCalls.map((entry) => ({
        toolCallId: entry.toolCallId,
        tool: entry.name,
        expertId: entry.arguments?.expertId,
        expertIds: entry.arguments?.experts?.map((item) => item?.expertId),
        modes: entry.arguments?.experts?.map((item) => String(item?.mode || "parallel")),
        resultAt: entry.resultAt ? entry.resultAt - entry.at : null
      })),
      consultResultCount: run.consultResults.length,
      parallelWindows,
      serialBarriers,
      followUps,
      experts: agents,
      orchestrationEvent: run.orchestrationEvent,
      doneFinishReason: run.doneEvent?.finishReason || null,
      finalTextLength: run.finalText.length,
      finalTextPreview: run.finalText.trim().slice(0, 600),
      transcriptEventCount: run.transcript.length
    }
  };
}

// ---- 主流程 ----

const artifactsDir = resolve(root, "artifacts", "agent-dispatch-background");
await mkdir(artifactsDir, { recursive: true });

// 离线重放：把录制下来的 transcript 喂进同一套采集与断言，用于回归历史误报
// （例如 run-1789748335844.jsonl 的 follow_up 混轮问题），不需要模型与网络。
const replayPath = process.argv[2] === "--replay" ? String(process.argv[3] || "").trim() : "";
if (process.argv[2] === "--replay") {
  if (!replayPath) {
    process.stderr.write("[agent-dispatch-bg-smoke] --replay 需要 transcript 路径\n");
    process.exit(2);
  }
  const replayCollector = createRunCollector();
  const lines = (await readFile(replayPath, "utf8")).trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      replayCollector.handleEvent(JSON.parse(line));
    } catch {
      // 忽略无法解析的行（录制尾部截断等）。
    }
  }
  const replayRun = replayCollector.snapshot({ ok: true, reason: "replay", sawDone: true });
  const replayVerdict = assertRun(replayRun);
  process.stdout.write(`[agent-dispatch-bg-smoke] replay=${replayPath} ok=${replayVerdict.ok}\n`);
  if (!replayVerdict.ok) {
    process.stdout.write(`[agent-dispatch-bg-smoke] replay failures: ${JSON.stringify(replayVerdict.failures, null, 2)}\n`);
  }
  process.stdout.write(`[agent-dispatch-bg-smoke] replay report: ${JSON.stringify(replayVerdict.report, null, 2)}\n`);
  process.stdout.write(`[agent-dispatch-bg-smoke] ${replayVerdict.ok ? "REPLAY-PASS" : "REPLAY-FAIL"}\n`);
  process.exit(replayVerdict.ok ? 0 : 1);
}

const egressError = await preflightMarketEgress();
if (egressError) {
  process.stderr.write([
    `[agent-dispatch-bg-smoke] 工具宿主行情出口不可达：${egressError}`,
    "OKX 公共 REST 需要走代理，且 NODE_USE_ENV_PROXY 必须在进程启动前设置，例如：",
    "  NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 \\",
    "  NO_PROXY=localhost,127.0.0.1,api.deepseek.com \\",
    "  node scripts/smoke-cline-sidecar-multi-agent-background.mjs",
    "本轮不执行：出口不可达会让所有专家证据调用失败，验收结果无法区分调度缺陷与网络缺陷。"
  ].join("\n") + "\n");
  process.exit(2);
}

process.stdout.write(`[agent-dispatch-bg-smoke] starting model=${model} baseUrl=${baseUrl} enabledAgents=${ENABLED_AGENTS.map((a) => a.id).join(",")}\n`);
const run = await runOnce();
const verdict = assertRun(run);
const transcriptPath = resolve(artifactsDir, `run-${Date.now()}.jsonl`);
await writeFile(transcriptPath, run.transcript.map((event) => JSON.stringify(event)).join("\n"), "utf8");
process.stdout.write(`[agent-dispatch-bg-smoke] ok=${verdict.ok} transcript=${transcriptPath}\n`);
if (!verdict.ok) {
  process.stdout.write(`[agent-dispatch-bg-smoke] failures: ${JSON.stringify(verdict.failures, null, 2)}\n`);
}
process.stdout.write(`[agent-dispatch-bg-smoke] report: ${JSON.stringify(verdict.report, null, 2)}\n`);
process.stdout.write(`[agent-dispatch-bg-smoke] ${verdict.ok ? "PASS" : "FAIL"}\n`);
process.exit(verdict.ok ? 0 : 1);
