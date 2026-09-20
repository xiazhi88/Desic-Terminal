// v3（docs/multi-agent-dispatch-plan-v3.md §3/§4，契约 C4/C5）：
// 本模块只保留"内容与结构"侧的纯函数——Profile 勾选名单解析、点名收窄的只读工具
// 白名单、缺依赖提示、进展心跳与报告回收。预算护栏（报告截断/停滞杀进程/总时限/咨询与
// 追问次数上限）与 backend 编排器（auto 打分、关键词 boost、复核波）已全部删除：
// 编排只有一条路，主 Agent 通过 consult_expert / follow_up 自己点名。

const PROFILE_READ_TOOLS_BY_SCOPE = Object.freeze({
  market: [
    "market.readTicker",
    "market.readInstrument",
    "market.readOrderBook",
    "market.readRecentTrades",
    "market.readCandles",
    "market.readFundingRate",
    "market.scanWatchlist",
    "market.readIndicators",
    "radar.readRanking",
    "radar.readInstrumentEvidence",
    "radar.compareMarkets",
    "radar.readBreadth",
    "radar.readRankHistory",
    "radar.readValidationReport",
    "radar.listSavedFilters"
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

// C15：scopes 不再是 Agent 文件字段，只在"主 Agent 点名时收窄"这一个用途上保留：
// 域 → 该域的只读工具，PROFILE_ALL_READ_TOOLS = 五个域的并集（缺省授予）。
export const PROFILE_SCOPE_NAMES = Object.freeze(Object.keys(PROFILE_READ_TOOLS_BY_SCOPE));

export const PROFILE_ALL_READ_TOOLS = Object.freeze([
  ...new Set(Object.values(PROFILE_READ_TOOLS_BY_SCOPE).flat())
]);

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

/// C4：运行配置载荷的 `enabledAgents` 是该 Profile 勾选且库中存在的 Agent（含正文）。
/// 解析规则（冻结）：按 id 去重并保持勾选顺序；丢弃缺 `id` / `name` / `body` 的条目；
/// **不截断、不打分、不按 requiresAccount / requiresSkill 静默过滤**——缺依赖只在
/// 该专家的任务前缀里提示（见 profileAgentDependencyNotices）。
/// C15：Agent 文件与载荷都不再有 `scopes`；旧载荷里带它一律忽略（不报错、不传递）。
export function normalizeEnabledProfileAgents(config = {}) {
  const source = config && typeof config === "object" ? config : {};
  const raw = Array.isArray(source.enabledAgents) ? source.enabledAgents : [];
  const seen = new Set();
  const agents = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const id = String(value.id || "").trim();
    const name = String(value.name || "").trim();
    const body = String(value.body || "").trim();
    if (!id || !name || !body) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const version = Number(value.version);
    const declaredEnvelope = String(value.envelope || "").trim().toLowerCase();
    const role = String(value.role || "custom").trim() || "custom";
    // C15.1：envelope 取严 = 声明 risk 或 role == account_risk（不再由 scopes 推导）。
    const envelope = declaredEnvelope === "risk" || role === "account_risk" ? "risk" : "standard";
    agents.push({
      id,
      name,
      role,
      envelope,
      skills: stringList(value.skills),
      requiresAccount: value.requiresAccount === true,
      source: String(value.source || "").trim() || "custom",
      version: Number.isInteger(version) ? version : 1,
      summary: String(value.summary || "").trim(),
      body
    });
  }
  return agents;
}

/// C4：缺账户 / 缺 Skill 不剔除专家，只在专家任务前缀里说明，由专家自己在
/// 数据缺口部分交代。
export function profileAgentDependencyNotices(agent, config = {}) {
  const notices = [];
  const hasAccount = Boolean(String(config?.agentProfileAccountId || "").trim());
  if (agent?.requiresAccount === true && !hasAccount) {
    notices.push("当前 Profile 未绑定账户，account 类证据不可用。");
  }
  const activeSkills = new Set(stringList(config?.activeSkillIds));
  for (const skill of stringList(agent?.skills)) {
    if (activeSkills.has(skill)) continue;
    notices.push(`Skill ${skill} 未激活，相关工具不可用；请在数据缺口部分说明。`);
  }
  return notices;
}

/// C5：无进展只回调通知，**永不 abort、永不 reject**——本 API 不持有任何中断能力，
/// 专家长跑不会被侧车杀死。调用方在每次 provider 进展时 reset()，之后每
/// repeatEveryMs 重复回调一次（默认 120s），直到 clear()。
export function createProfileAgentProgressPulse({
  notifyAfterMs = 120_000,
  repeatEveryMs = 120_000,
  onNotice = () => {},
  now = () => Date.now(),
  schedule = setTimeout,
  cancel = clearTimeout
} = {}) {
  const firstDelayMs = Number.isFinite(notifyAfterMs) && notifyAfterMs > 0 ? notifyAfterMs : 120_000;
  const repeatDelayMs = Number.isFinite(repeatEveryMs) && repeatEveryMs > 0 ? repeatEveryMs : firstDelayMs;
  let timer = null;
  let active = true;
  let notices = 0;
  const startedAt = now();
  let lastProgressAt = startedAt;

  const arm = () => {
    if (!active) return;
    if (timer !== null) cancel(timer);
    timer = schedule(fire, notices === 0 ? firstDelayMs : repeatDelayMs);
  };

  const fire = () => {
    if (!active) return;
    timer = null;
    notices += 1;
    const current = now();
    try {
      onNotice({
        elapsedMs: Math.max(0, current - startedAt),
        silentMs: Math.max(0, current - lastProgressAt)
      });
    } catch {
      // 提示上报失败不得影响专家运行。
    }
    arm();
  };

  return {
    /// 记录一次进展并重新计时（首次调用即启动心跳）。
    reset() {
      if (!active) return;
      lastProgressAt = now();
      arm();
    },
    clear() {
      active = false;
      if (timer !== null) cancel(timer);
      timer = null;
    }
  };
}

/// C15.2：点名收窄的工具面。不传或空数组 → 全部只读工具（缺省不限制）；传域 →
/// 这些域的并集。注意：非法域**不在这里静默过滤**——点名时的白名单校验在
/// cline-sidecar 的 consult_expert/follow_up 入口完成（非法值直接报错）。
export function profileAgentToolAllowlist(scopes) {
  const declaredScopes = stringList(scopes);
  if (declaredScopes.length === 0) return [...PROFILE_ALL_READ_TOOLS];
  const tools = new Set();
  for (const scope of declaredScopes) {
    for (const name of PROFILE_READ_TOOLS_BY_SCOPE[scope] || []) tools.add(name);
  }
  return Array.from(tools);
}

/// C15.2：本次实际授予的域——缺省（不传/空数组）为全部五个；收窄时保持声明顺序去重。
export function grantedProfileScopes(scopes) {
  const declaredScopes = stringList(scopes);
  if (declaredScopes.length === 0) return [...PROFILE_SCOPE_NAMES];
  return declaredScopes
    .map((scope) => scope.toLowerCase())
    .filter((scope, index, items) => PROFILE_SCOPE_NAMES.includes(scope) && items.indexOf(scope) === index);
}

/// C15.2：点名时出现白名单外的域必须报错并列出非法值（禁止静默过滤）。
export function invalidProfileScopes(scopes) {
  return stringList(scopes)
    .map((scope) => scope.toLowerCase())
    .filter((scope) => !PROFILE_SCOPE_NAMES.includes(scope));
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

/// D1: report content is never judged by format. A prose report is a valid
/// report; failure comes only from an anomalous finishReason or empty output.
/// A structured JSON object (raw, fenced, or brace-sliced) is optional extra:
/// when it parses it is returned as-is with every field optional, and when it
/// does not the whole text is the report body. v3 指令 1：正文不做任何长度变换，
/// 报告原样回流主 Agent。
export function collectProfileAgentReport(result) {
  const finishReason = String(result?.finishReason || "error").trim().toLowerCase();
  const text = String(result?.text || "").trim();
  if (finishReason === "error") {
    const error = !text || /^(error|failed)$/i.test(text)
      ? "模型服务未返回可用结果"
      : text;
    return { present: false, status: "failed", error, text };
  }
  if (finishReason !== "completed") {
    return {
      present: false,
      status: "failed",
      error: `Agent 未正常完成（${finishReason || "error"}）`,
      text
    };
  }
  if (!text) {
    return { present: false, status: "failed", error: "Agent 未返回可用报告", text: "" };
  }
  return { present: true, status: "success", error: "", report: parseProfileAgentJson(text), text };
}
