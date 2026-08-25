export const AI_PERMISSION_MODES = new Set(["advisor", "copilot", "limited_auto"]);
export const AI_AGENT_ROLES = new Set(["main", "subagent", "team"]);

export const ANALYSIS_TOOLS = new Set([
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
  "radar.listSavedFilters",
  "account.readSnapshot",
  "account.readBalances",
  "account.readPositions",
  "account.readOpenOrders",
  "account.readOrderStatus",
  "account.readRisk",
  "account.readHistoricalOrders",
  "account.readHistoricalFills",
  "account.readBills",
  "account.readPositionEpisodes",
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
  "intelligence.news.listAnomalies",
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
  "intelligence.smartMoney.readSignalTrendByTrader",
  "intelligence.smartMoney.readMarketPositioning",
  "intelligence.smartMoney.readTakerFlow",
  "intelligence.smartMoney.readDerivativeDecisionContext",
  "intelligence.smartMoney.readCrowdingComparison",
  "intelligence.smartMoney.readFundingBasis",
  "intelligence.smartMoney.readLiquidationSamples",
  "intelligence.smartMoney.readSystemStress",
  "intelligence.smartMoney.readPositionChanges",
  "intelligence.smartMoney.readConsensusDivergence",
  "trade.evaluatePlan",
  "trade.precheck",
  "research.webSearch",
  "strategy.readDevelopmentDocs",
  "strategy.readCurrentSource",
  "strategy.testCurrentSource",
  "strategy.listVersions",
  "strategy.getVersion",
  "strategy.inspectDataCoverage",
  "strategy.sampleMarketData",
  "strategy.getBacktestResult",
  "strategy.getBacktestTrades",
  "strategy.getBacktestDiagnostics",
  "strategy.compareBacktests",
  "strategy.getOptimizationResult",
  "skill.readResource",
  "skills"
]);

export const LOCAL_SIDE_EFFECT_TOOLS = new Set([
  "journal.createNote",
  "chart.createDrawing",
  "chart.updateDrawing",
  "chart.deleteDrawing",
  "alert.createPriceAlert",
  "alert.updatePriceAlert",
  "alert.deletePriceAlert",
  "alert.listPriceAlerts",
  "script.createOrUpdate",
  "script.run",
  "script.enable",
  "script.delete",
  "script.list",
  "strategy.applySource",
  "strategy.create",
  "strategy.saveVersion",
  "strategy.rollbackVersion",
  "strategy.backtest",
  "strategy.optimize",
  "skill.run"
]);

export const OPPORTUNITY_READ_TOOLS = new Set([
  "tradeOpportunity.list",
  "tradeOpportunity.get"
]);

export const FINAL_DECISION_TOOLS = new Set(["market.readDecisionContext"]);

export const OPPORTUNITY_WRITE_TOOLS = new Set([
  "tradeOpportunity.create",
  "tradeOpportunity.revise",
  "tradeOpportunity.reuse",
  "tradeOpportunity.close"
]);

export const NOTIFICATION_TOOLS = new Set(["notification.feishu.send"]);
export const BACKGROUND_TOOLS = new Set(["background.finishRun"]);
export const REVIEW_TOOLS = new Set([
  "review.readSkillVersion",
  "review.complete",
  "optimizationSuggestion.create"
]);

// Backward-compatible category name used by earlier policy tests/callers.
export const OPPORTUNITY_TOOLS = OPPORTUNITY_WRITE_TOOLS;

export const ORCHESTRATION_TOOLS = new Set([
  "spawn_agent",
  "team_spawn_teammate",
  "team_shutdown_teammate",
  "team_status",
  "team_task",
  "team_run_task",
  "team_cancel_run",
  "team_list_runs",
  "team_await_runs",
  "team_send_message",
  "team_broadcast",
  "team_read_mailbox",
  "team_mission_log",
  "team_cleanup",
  "team_create_outcome",
  "team_attach_outcome_fragment",
  "team_review_outcome_fragment",
  "team_finalize_outcome",
  "team_list_outcomes"
]);

export const TRADE_TOOLS = new Set([
  "trade.placeOrder",
  "trade.cancelOrder",
  "trade.amendOrder",
  "trade.closePosition",
  "trade.setLeverage",
  "trade.setMarginMode",
  "order.create",
  "order.cancel",
  "okx.placeOrder",
  "okx.cancelOrder",
  "okx.amendOrder",
  "okx.closePosition",
  "okx.setLeverage",
  "okx.setMarginMode"
]);

export const PROHIBITED_TOOLS = new Set([
  "apply_patch",
  "editor"
]);

export const DISABLED_SUBAGENT_WRAPPER_TOOLS = new Set([
  "subagent_readonly_analyst"
]);

// Backward-compatible export for callers that previously treated every non-trade
// tool as read-only. This set now contains only tools that do not change domain state.
export const READ_TOOLS = ANALYSIS_TOOLS;

export function requiredSkillForTool(name) {
  const canonicalName = toCanonicalToolName(name);
  if (canonicalName.startsWith("intelligence.news.") || canonicalName.startsWith("intelligence.smartMoney.")) return "okx-market-intelligence";
  if (canonicalName.startsWith("radar.")) return "market-radar-research";
  return null;
}

export function isSkillToolEnabled(name, activeSkillIds = []) {
  const requiredSkill = requiredSkillForTool(name);
  if (!requiredSkill) return true;
  return new Set(Array.isArray(activeSkillIds) ? activeSkillIds.map(String) : []).has(requiredSkill);
}

export function toProviderToolName(name) {
  return String(name || "").replaceAll(".", "_");
}

export function toProviderToolReferences(value) {
  let text = String(value ?? "");
  const canonicalNames = allKnownToolNames()
    .filter((name) => name.includes("."))
    .sort((left, right) => right.length - left.length);
  for (const canonicalName of canonicalNames) {
    text = text.replaceAll(canonicalName, toProviderToolName(canonicalName));
  }
  return text;
}

export function toCanonicalToolName(name) {
  const value = String(name || "");
  if (allKnownToolNames().includes(value)) return value;
  for (const known of allKnownToolNames()) {
    if (toProviderToolName(known) === value) return known;
  }
  return value;
}

export function normalizePermissionMode(value) {
  const mode = String(value || "advisor").trim().toLowerCase().replaceAll("-", "_");
  if (mode === "readonly") return "advisor";
  if (mode === "approval") return "copilot";
  if (mode === "full") return "copilot";
  return AI_PERMISSION_MODES.has(mode) ? mode : "advisor";
}

export function normalizeAgentRole(value) {
  const role = String(value || "main").trim().toLowerCase();
  return AI_AGENT_ROLES.has(role) ? role : "main";
}

export function allKnownToolNames() {
  return Array.from(new Set([
    ...ANALYSIS_TOOLS,
    ...LOCAL_SIDE_EFFECT_TOOLS,
    ...OPPORTUNITY_READ_TOOLS,
    ...FINAL_DECISION_TOOLS,
    ...OPPORTUNITY_WRITE_TOOLS,
    ...NOTIFICATION_TOOLS,
    ...BACKGROUND_TOOLS,
    ...REVIEW_TOOLS,
    ...ORCHESTRATION_TOOLS,
    ...TRADE_TOOLS,
    ...PROHIBITED_TOOLS,
    ...DISABLED_SUBAGENT_WRAPPER_TOOLS
  ]));
}

export function resolveToolPolicy(name, config = {}) {
  const canonicalName = toCanonicalToolName(name);
  const mode = normalizePermissionMode(config.permissionMode);
  const role = normalizeAgentRole(config.agentRole);
  const allowlist = toolAllowlistConfig(config.toolAllowlist);
  const openAgent = boolConfig(config.openAgent, false);
  const knownTool = allKnownToolNames().includes(canonicalName);
  const desicTool = knownTool
    && !PROHIBITED_TOOLS.has(canonicalName)
    && !DISABLED_SUBAGENT_WRAPPER_TOOLS.has(canonicalName);

  if (String(config.strategySessionKind || "") === "trading-research"
    && ["strategy.readCurrentSource", "strategy.testCurrentSource", "strategy.applySource"].includes(canonicalName)) {
    return disabledPolicy("disabled:trading-assistant-no-editor-access");
  }

  // In open-agent mode the allowlist remains a boundary for Desic-owned tools,
  // while Cline's native tools are intentionally governed by Cline itself.
  if (allowlist.size > 0 && desicTool && !allowlist.has(canonicalName)) {
    return disabledPolicy("disabled:not-in-tool-allowlist");
  }

  if (PROHIBITED_TOOLS.has(canonicalName) && openAgent) {
    return enabledPolicy("auto-approved:cline-native-tool");
  }
  if (PROHIBITED_TOOLS.has(canonicalName)) {
    return disabledPolicy("disabled:prohibited-tool");
  }
  if (canonicalName === "skills" && boolConfig(config.disableSkillsTool, false)) {
    return disabledPolicy("disabled:run-uses-locked-skill-snapshot");
  }
  if (DISABLED_SUBAGENT_WRAPPER_TOOLS.has(canonicalName)) {
    return disabledPolicy("disabled:use-spawn-agent-for-observable-subtasks");
  }
  if (openAgent && !knownTool) {
    return enabledPolicy("auto-approved:cline-native-tool");
  }
  if (canonicalName === "skill.run") {
    if (role !== "main") return disabledPolicy("disabled:skill-run-main-interactive-only");
    if (boolConfig(config.backgroundRun, false)) return disabledPolicy("disabled:skill-run-interactive-only");
    return enabledPolicy("auto-approved:main-interactive-skill-run");
  }

  if (ANALYSIS_TOOLS.has(canonicalName)) {
    if (
      (canonicalName.startsWith("strategy.") || canonicalName === "skill.readResource")
      && role !== "main"
    ) {
      return disabledPolicy("disabled:strategy-editor-main-session-only");
    }
    return enabledPolicy("auto-approved:analysis-read");
  }

  if (role !== "main") {
    if (OPPORTUNITY_READ_TOOLS.has(canonicalName)) {
      return enabledPolicy("auto-approved:delegated-opportunity-read");
    }
    if (
      LOCAL_SIDE_EFFECT_TOOLS.has(canonicalName)
      || OPPORTUNITY_READ_TOOLS.has(canonicalName)
      || OPPORTUNITY_WRITE_TOOLS.has(canonicalName)
      || FINAL_DECISION_TOOLS.has(canonicalName)
      || NOTIFICATION_TOOLS.has(canonicalName)
      || BACKGROUND_TOOLS.has(canonicalName)
      || REVIEW_TOOLS.has(canonicalName)
      || TRADE_TOOLS.has(canonicalName)
    ) {
      return disabledPolicy("disabled:analysis-role-no-side-effects");
    }
    if (ORCHESTRATION_TOOLS.has(canonicalName)) {
      return disabledPolicy("disabled:delegated-agent-no-orchestration");
    }
    return disabledPolicy("disabled:unknown-tool");
  }

  if (OPPORTUNITY_READ_TOOLS.has(canonicalName)) {
    return enabledPolicy("auto-approved:main-opportunity-read");
  }

  if (FINAL_DECISION_TOOLS.has(canonicalName)) {
    if (!boolConfig(config.backgroundRun, false)) return disabledPolicy("disabled:final-context-background-only");
    return enabledPolicy("auto-approved:main-final-decision-context");
  }

  if (NOTIFICATION_TOOLS.has(canonicalName)) {
    return enabledPolicy("auto-approved:main-notification");
  }

  if (LOCAL_SIDE_EFFECT_TOOLS.has(canonicalName)) {
    return enabledPolicy("auto-approved:main-local-effect");
  }

  if (BACKGROUND_TOOLS.has(canonicalName)) {
    if (!boolConfig(config.backgroundRun, false)) return disabledPolicy("disabled:not-background-run");
    return enabledPolicy("auto-approved:background-run");
  }

  if (REVIEW_TOOLS.has(canonicalName)) {
    if (!boolConfig(config.reviewRun, false)) return disabledPolicy("disabled:not-review-run");
    return enabledPolicy("auto-approved:review-run");
  }

  if (ORCHESTRATION_TOOLS.has(canonicalName)) {
    if (canonicalName === "spawn_agent" && !boolConfig(config.enableSpawnAgent, true)) {
      return disabledPolicy("disabled:spawn-agent-off");
    }
    if (canonicalName.startsWith("team_") && !boolConfig(config.enableAgentTeams, true)) {
      return disabledPolicy("disabled:agent-teams-off");
    }
    return enabledPolicy("auto-approved:main-orchestration");
  }

  if (OPPORTUNITY_WRITE_TOOLS.has(canonicalName)) {
    if (mode === "advisor") return disabledPolicy("disabled:advisor-read-only");
    if (
      boolConfig(config.backgroundRun, false)
      && (canonicalName === "tradeOpportunity.reuse" || canonicalName === "tradeOpportunity.revise")
    ) {
      return disabledPolicy("disabled:background-opportunity-commit-only");
    }
    return enabledPolicy(mode === "copilot" ? "auto-approved:copilot" : "auto-approved:limited-auto");
  }

  if (canonicalName === "trade.setLeverage") {
    if (!boolConfig(config.backgroundRun, false)) {
      return disabledPolicy("disabled:profile-leverage-only");
    }
    if (mode === "copilot" || mode === "limited_auto") {
      return enabledPolicy("auto-approved:profile-target-leverage");
    }
    return disabledPolicy("disabled:advisor-read-only");
  }

  if (TRADE_TOOLS.has(canonicalName)) {
    return disabledPolicy("disabled:ai-direct-trade-replaced-by-opportunity");
  }

  return disabledPolicy("disabled:unknown-tool");
}

export function createBeforeToolHook(policyConfig = {}) {
  return ({ snapshot, tool } = {}) => {
    const agentRole = snapshot?.parentAgentId
      ? "subagent"
      : (snapshot?.agentRole || policyConfig.agentRole || "main");
    const resolved = resolveToolPolicy(tool?.name, { ...policyConfig, agentRole });
    if (!resolved.allowed) {
      return {
        skip: true,
        reason: resolved.policy,
        policy: { enabled: false, autoApprove: false }
      };
    }
    return { policy: { enabled: true, autoApprove: true } };
  };
}

export function buildToolPolicies(config = {}) {
  if (boolConfig(config.openAgent, false)) {
    return { "*": { enabled: true, autoApprove: true } };
  }
  const policies = { "*": { enabled: false, autoApprove: false } };
  for (const name of allKnownToolNames()) {
    const resolved = resolveToolPolicy(name, config);
    const policy = { enabled: resolved.enabled, autoApprove: resolved.autoApprove };
    policies[name] = policy;
    policies[toProviderToolName(name)] = policy;
  }
  return policies;
}

export function describeToolPolicy(name, config = {}) {
  const { allowed, blocked, policy } = resolveToolPolicy(name, config);
  return { allowed, blocked, policy };
}

export function annotateToolEvent(event, config = {}) {
  if (!event || event.type !== "toolCall") return event;
  return {
    ...event,
    ...describeToolPolicy(event.name, config),
    allowedTools: allKnownToolNames().filter((name) => resolveToolPolicy(name, config).allowed)
  };
}

function enabledPolicy(policy) {
  return { enabled: true, autoApprove: true, allowed: true, blocked: false, policy };
}

function disabledPolicy(policy) {
  return { enabled: false, autoApprove: false, allowed: false, blocked: true, policy };
}

function boolConfig(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function stringListConfig(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function toolAllowlistConfig(value) {
  return new Set(stringListConfig(value).map((name) => toCanonicalToolName(name)));
}
