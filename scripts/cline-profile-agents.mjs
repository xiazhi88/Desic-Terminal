export const PROFILE_AUTO_MULTI_AGENT_MAX = 8;
export const PROFILE_CUSTOM_MULTI_AGENT_MAX = 10;
export const PROFILE_MULTI_AGENT_MAX = PROFILE_AUTO_MULTI_AGENT_MAX;
export const PROFILE_MULTI_AGENT_REPORT_LIMIT = 12_000;
export const PROFILE_MULTI_AGENT_STALL_TIMEOUT_MS = 180_000;

export function createProfileAgentStallWatchdog(onStall, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : PROFILE_MULTI_AGENT_STALL_TIMEOUT_MS;
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  let timer = null;
  let active = true;
  return {
    reset() {
      if (!active) return;
      if (timer !== null) cancel(timer);
      timer = schedule(onStall, timeoutMs);
    },
    clear() {
      active = false;
      if (timer !== null) cancel(timer);
      timer = null;
    }
  };
}

const PROFILE_AGENT_SCOPE_TOOLS = Object.freeze({
  market: [
    "market.readTicker",
    "market.readInstrument",
    "market.readOrderBook",
    "market.readRecentTrades",
    "market.readCandles",
    "market.readFundingRate",
    "market.scanWatchlist",
    "market.readIndicators"
  ],
  derivatives: [
    "market.readFundingRate",
    "intelligence.news.listAnomalies",
    "intelligence.smartMoney.readMarketPositioning",
    "intelligence.smartMoney.readTakerFlow",
    "intelligence.smartMoney.readDerivativeDecisionContext",
    "intelligence.smartMoney.readCrowdingComparison",
    "intelligence.smartMoney.readFundingBasis",
    "intelligence.smartMoney.readLiquidationSamples",
    "intelligence.smartMoney.readSystemStress",
    "intelligence.smartMoney.readPositionChanges",
    "intelligence.smartMoney.readConsensusDivergence"
  ],
  intelligence: [
    "intelligence.news.list",
    "intelligence.news.search",
    "intelligence.news.readDetail",
    "intelligence.news.listSources",
    "intelligence.news.readCoinSentiment",
    "intelligence.news.readCoinSentimentTrend",
    "intelligence.news.readSentimentRanking",
    "intelligence.news.readEconomicCalendar",
    "intelligence.news.listEvents",
    "intelligence.news.readEvent",
    "intelligence.news.readMarketReaction",
    "intelligence.news.readDailyBriefing",
    "intelligence.smartMoney.listTradersByFilter",
    "intelligence.smartMoney.searchTrader",
    "intelligence.smartMoney.readPerformanceByTrader",
    "intelligence.smartMoney.readTraderPositions",
    "intelligence.smartMoney.readTraderPositionHistory",
    "intelligence.smartMoney.readTraderOrderHistory",
    "intelligence.smartMoney.readSignalOverviewByFilter",
    "intelligence.smartMoney.readSignalOverviewByTrader",
    "intelligence.smartMoney.readSignalTrendByFilter",
    "intelligence.smartMoney.readSignalTrendByTrader"
  ],
  account: [
    "account.readSnapshot",
    "account.readBalances",
    "account.readPositions",
    "account.readOpenOrders",
    "account.readOrderStatus",
    "account.readRisk",
    "trade.evaluatePlan",
    "trade.precheck"
  ],
  history: [
    "account.readHistoricalOrders",
    "account.readHistoricalFills",
    "account.readBills",
    "account.readPositionEpisodes",
    "tradeOpportunity.list",
    "tradeOpportunity.get"
  ]
});

const PROFILE_AGENT_ALL_TOOLS = Object.freeze([...new Set(Object.values(PROFILE_AGENT_SCOPE_TOOLS).flat())]);

const AUTO_PROFILE_AGENTS = Object.freeze([
  {
    id: "auto-market-structure",
    name: "市场结构",
    role: "market_structure",
    responsibility: "检查多周期价格结构、趋势、波动、成交、盘口和关键失效位，明确事实与推断。",
    scopes: ["market", "derivatives"],
    required: true,
    enabled: true
  },
  {
    id: "auto-order-flow-liquidity",
    name: "订单流与流动性",
    role: "order_flow_liquidity",
    responsibility: "检查盘口深度、买卖价差、逐笔成交、主动买卖和流动性缺口，识别短时冲击与滑点风险。",
    scopes: ["market"],
    required: false,
    enabled: true
  },
  {
    id: "auto-derivatives-positioning",
    name: "衍生品仓位",
    role: "derivatives_positioning",
    responsibility: "检查资金费率、基差、持仓拥挤、爆仓样本和仓位变化，判断杠杆方向及挤压风险。",
    scopes: ["derivatives", "market"],
    required: false,
    enabled: true
  },
  {
    id: "auto-account-risk",
    name: "账户风险",
    role: "account_risk",
    responsibility: "检查仓位、余额、保证金、挂单、集中度与历史相似交易；风险结论只能收紧或否决。",
    scopes: ["account", "history", "market"],
    required: true,
    enabled: true,
    requiresAccount: true
  },
  {
    id: "auto-intelligence-flow",
    name: "新闻与宏观",
    role: "intelligence_flow",
    responsibility: "检查新闻、宏观日历、事件、情绪与市场反应，标注发布时间、来源、重要性和证据冲突。",
    scopes: ["intelligence"],
    required: false,
    enabled: true,
    requiresSkill: "okx-market-intelligence"
  },
  {
    id: "auto-smart-money",
    name: "Smart Money",
    role: "smart_money",
    responsibility: "检查精英交易员仓位、绩效、订单历史、共识分歧和资金流趋势，区分领先信号与拥挤跟随。",
    scopes: ["intelligence", "derivatives"],
    required: false,
    enabled: true,
    requiresSkill: "okx-market-intelligence"
  },
  {
    id: "auto-historical-analogy",
    name: "历史类比",
    role: "historical_analogy",
    responsibility: "检索历史订单、成交、持仓阶段和既有交易机会，比较相似情境、结果分布与失效条件。",
    scopes: ["history", "market"],
    required: false,
    enabled: true
  },
  {
    id: "auto-contrarian-review",
    name: "反方审查",
    role: "contrarian",
    responsibility: "主动寻找反证、过期数据、缺失证据、拥挤交易和相反市场路径，不重复正向结论。",
    scopes: ["market", "derivatives", "intelligence", "history"],
    required: false,
    enabled: true
  }
]);

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

export function normalizeProfileMultiAgentMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  return mode === "auto" || mode === "custom" ? mode : "off";
}

function normalizeProfileAgent(value, index) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || `profile-agent-${index + 1}`).trim();
  const name = String(value.name || `分析 Agent ${index + 1}`).trim();
  const responsibility = String(value.responsibility || "").trim();
  const scopes = stringList(value.scopes)
    .map((scope) => scope.toLowerCase())
    .filter((scope, scopeIndex, items) => PROFILE_AGENT_SCOPE_TOOLS[scope] && items.indexOf(scope) === scopeIndex);
  if (!id || !name || !responsibility || value.enabled === false) return null;
  return {
    id,
    name,
    role: String(value.role || "custom").trim() || "custom",
    responsibility,
    scopes,
    required: value.required === true,
    enabled: true
  };
}

export function profileAgentToolAllowlist(scopes) {
  const declaredScopes = stringList(scopes);
  if (declaredScopes.length === 0) return [...PROFILE_AGENT_ALL_TOOLS];
  const tools = new Set();
  for (const scope of declaredScopes) {
    for (const name of PROFILE_AGENT_SCOPE_TOOLS[scope] || []) tools.add(name);
  }
  return Array.from(tools);
}

export function resolveProfileMultiAgents(config = {}, taskText = "") {
  if (config.backgroundRun !== true || config.reviewRun === true) return [];
  const mode = normalizeProfileMultiAgentMode(config.multiAgentMode);
  if (mode === "off") return [];
  const parsedMax = Number(config.multiAgentMaxAgents);
  const modeLimit = mode === "custom"
    ? PROFILE_CUSTOM_MULTI_AGENT_MAX
    : PROFILE_AUTO_MULTI_AGENT_MAX;
  const maxAgents = Math.min(
    modeLimit,
    Math.max(2, Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : modeLimit)
  );
  if (mode === "custom") {
    const agents = (Array.isArray(config.multiAgents) ? config.multiAgents : [])
      .map(normalizeProfileAgent)
      .filter(Boolean);
    if (agents.length > maxAgents) {
      throw new Error(`已启用 ${agents.length} 个自定义 Agent，超过当前上限 ${maxAgents}`);
    }
    return agents;
  }
  const activeSkills = new Set(stringList(config.activeSkillIds));
  const hasAccount = Boolean(String(config.agentProfileAccountId || "").trim());
  const agents = AUTO_PROFILE_AGENTS.filter((agent) => {
    if (agent.requiresAccount && !hasAccount) return false;
    if (agent.requiresSkill && !activeSkills.has(agent.requiresSkill)) return false;
    return true;
  });
  const task = String(taskText || "");
  const scores = new Map([
    ["auto-market-structure", 1_000],
    ["auto-account-risk", 900],
    ["auto-contrarian-review", 80],
    ["auto-intelligence-flow", 75],
    ["auto-smart-money", 74],
    ["auto-order-flow-liquidity", 70],
    ["auto-derivatives-positioning", 65],
    ["auto-historical-analogy", 60]
  ]);
  const boost = (id, amount) => scores.set(id, (scores.get(id) || 0) + amount);
  if (/新闻|情报|宏观|事件|情绪|公告|news|intelligence|macro|sentiment/i.test(task)) {
    boost("auto-intelligence-flow", 150);
  }
  if (/聪明钱|精英交易员|资金流|smart\s*money|trader\s*flow/i.test(task)) {
    boost("auto-smart-money", 160);
    boost("auto-derivatives-positioning", 25);
  }
  if (/盘口|订单流|深度|流动性|价差|逐笔|主动买|主动卖|order\s*flow|order\s*book|liquidity|spread/i.test(task)) {
    boost("auto-order-flow-liquidity", 150);
    boost("auto-derivatives-positioning", 20);
  }
  if (/资金费率|基差|持仓量|爆仓|清算|拥挤|挤压|funding|basis|open\s*interest|liquidation|crowding|squeeze/i.test(task)) {
    boost("auto-derivatives-positioning", 150);
  }
  if (/历史|类比|复盘|相似交易|历史订单|history|historical|analogy|postmortem/i.test(task)) {
    boost("auto-historical-analogy", 150);
    boost("auto-contrarian-review", 20);
  }
  if (/账户|余额|仓位|保证金|风险|回撤|挂单|account|balance|position|margin|risk|drawdown/i.test(task)) {
    boost("auto-account-risk", 150);
    boost("auto-contrarian-review", 40);
  }
  return agents
    .map((agent, index) => ({ agent, index, score: scores.get(agent.id) || 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxAgents)
    .map(({ agent }) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      responsibility: agent.responsibility,
      scopes: [...agent.scopes],
      required: agent.required,
      enabled: true
    }));
}

export function truncateProfileAgentReport(value) {
  const text = String(value || "").trim();
  if (text.length <= PROFILE_MULTI_AGENT_REPORT_LIMIT) return text;
  return `${text.slice(0, PROFILE_MULTI_AGENT_REPORT_LIMIT).trim()}\n[报告已截断]`;
}

export function profileAgentHistoricalReviewRules(prompt) {
  if (!/每日市场复盘|复盘日期与 UTC 数据窗口/.test(String(prompt || ""))) return [];
  return [
    "这是固定 UTC 时间窗的历史复盘。所有历史结论必须使用该窗口内的证据；当前行情或当前仓位只能作为明确标注的复盘后补充，不能替代目标日期数据。",
    "Smart Money 日内证据优先调用 intelligence.smartMoney.readSignalTrendByFilter：instId 使用完整永续交易对（例如 BTC-USDT-SWAP），granularity=1h，ts 使用窗口 endTime-1 的 13 位毫秒字符串，limit 按窗口小时数设置；运行时会把 ts 转成 OKX UTC+8 小时 dataVersion。readSignalOverviewByFilter 是当前概览且不得传时间参数；不得把它的 fetchedAt 或 weightedLongRatio 归入目标历史日期。",
    "intelligence.news.readDailyBriefing 读取的是可选的预生成产物，不是原始市场数据。返回空列表只表示该日期没有生成简报，不得单独列为严重数据缺口，也不得因此 veto。",
    "System Stress 的 coverage 按返回的时间桶理解；ADL unknown 表示没有可确认的警告状态。应披露实际覆盖时间范围，但不得把 unknown 描述为已经发生 ADL。"
  ];
}

function stringArray(value) {
  if (!Array.isArray(value)) return null;
  if (value.some((item) => typeof item !== "string" || !item.trim())) return null;
  return value.map((item) => item.trim());
}

function parseProfileAgentJson(text) {
  const candidates = [text];
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean);
  candidates.push(...fenced);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1).trim());
  }
  const parsed = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed.push(value);
    } catch {
      // Only complete JSON objects are accepted.
    }
  }
  return parsed.length === 1 ? parsed[0] : null;
}

export function parseProfileAgentResult(result) {
  const finishReason = String(result?.finishReason || "error").trim().toLowerCase();
  const text = String(result?.text || "").trim();
  if (finishReason === "error") {
    const error = !text || /^(error|failed)$/i.test(text)
      ? "模型服务未返回可用结果"
      : text;
    return { success: false, status: "blocked", error, text };
  }
  if (!text) {
    return { success: false, status: "blocked", error: "Agent 未返回可用报告", text: "" };
  }
  const report = parseProfileAgentJson(text);
  if (!report) {
    return { success: false, status: "blocked", error: "Agent 报告不是有效 JSON", text };
  }
  const status = String(report.status || "").trim().toLowerCase();
  const stance = String(report.stance || "").trim().toLowerCase();
  const confidence = Number(report.confidence);
  const timeHorizon = String(report.timeHorizon || "").trim();
  const evidence = stringArray(report.evidence);
  const risks = stringArray(report.risks);
  const invalidation = stringArray(report.invalidation);
  const missingData = stringArray(report.missingData);
  const recommendation = String(report.recommendation || "").trim();
  const blockedWithoutEvidence = status === "blocked"
    && evidence?.length === 0
    && ((risks?.length || 0) > 0 || (missingData?.length || 0) > 0);
  const valid = ["success", "partial", "blocked"].includes(status)
    && ["bullish", "bearish", "neutral", "risk"].includes(stance)
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 100
    && Boolean(timeHorizon)
    && evidence !== null
    && (evidence.length > 0 || blockedWithoutEvidence)
    && risks !== null
    && invalidation !== null
    && missingData !== null
    && Boolean(recommendation)
    && (report.veto === undefined || typeof report.veto === "boolean")
    && (report.vetoReason === undefined || typeof report.vetoReason === "string")
    && (report.veto !== true || Boolean(String(report.vetoReason || "").trim()));
  if (!valid) {
    return { success: false, status: "blocked", error: "Agent 报告字段不完整或类型无效", text };
  }
  const normalized = {
    status,
    stance,
    confidence,
    timeHorizon,
    evidence,
    risks,
    invalidation,
    missingData,
    recommendation,
    veto: report.veto === true,
    vetoReason: String(report.vetoReason || "").trim()
  };
  const success = finishReason === "completed" && status === "success";
  const blockedReason = status === "blocked"
    ? risks[0] || missingData[0] || recommendation
    : "";
  const error = success
    ? ""
    : finishReason !== "completed"
      ? `Agent 未正常完成（${finishReason || "error"}）`
      : `Agent 报告状态为 ${status}${blockedReason ? `：${blockedReason}` : ""}`;
  return {
    success,
    status,
    error,
    report: normalized,
    text: JSON.stringify(normalized)
  };
}
