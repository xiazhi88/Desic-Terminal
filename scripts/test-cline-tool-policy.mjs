import {
  buildToolPolicies,
  createBeforeToolHook,
  describeToolPolicy,
  isSkillToolEnabled,
  normalizePermissionMode,
  toProviderToolName,
  toProviderToolReferences
} from "./cline-tool-policy.mjs";
import { toClineRuntimeSessionId } from "./cline-session-id.mjs";

const failures = [];

function expectEqual(label, actual, expected) {
  if (actual !== expected) failures.push(`${label} expected ${expected}, got ${actual}`);
}

function expectTrue(label, value) {
  if (!value) failures.push(`${label} expected true, got ${value}`);
}

function expectPolicy(config, name, expected) {
  const policies = buildToolPolicies(config);
  const policy = policies[name] ?? policies["*"];
  for (const [key, value] of Object.entries(expected)) {
    if (policy?.[key] !== value) {
      failures.push(`${JSON.stringify(config)}:${name}.${key} expected ${value}, got ${policy?.[key]}`);
    }
  }
}

expectEqual("legacy readonly", normalizePermissionMode("readonly"), "advisor");
expectEqual("legacy approval", normalizePermissionMode("approval"), "copilot");
expectEqual("legacy full", normalizePermissionMode("full"), "copilot");
expectEqual("hyphenated limited auto", normalizePermissionMode("limited-auto"), "limited_auto");
expectEqual("unknown mode", normalizePermissionMode("unsafe-yolo"), "advisor");
expectEqual(
  "model-facing tool references use registered provider names",
  toProviderToolReferences(
    "先调用 intelligence.news.readCoinSentimentTrend，再调用 background.finishRun。"
  ),
  "先调用 intelligence_news_readCoinSentimentTrend，再调用 background_finishRun。"
);
expectEqual(
  "unknown dotted references remain unchanged",
  toProviderToolReferences("unknown.tool"),
  "unknown.tool"
);

const backgroundRuntimeId = toClineRuntimeSessionId("background:run-1783846479178078900");
const reviewRuntimeId = toClineRuntimeSessionId("review:review-1783846479178078900");
expectTrue("background runtime id removes Windows-invalid characters", !/[<>:"/\\|?*\u0000-\u001f]/.test(backgroundRuntimeId));
expectTrue("review runtime id removes Windows-invalid characters", !/[<>:"/\\|?*\u0000-\u001f]/.test(reviewRuntimeId));
expectEqual("runtime id is stable", backgroundRuntimeId, toClineRuntimeSessionId("background:run-1783846479178078900"));
expectTrue("sanitized ids remain collision resistant", toClineRuntimeSessionId("run:a") !== toClineRuntimeSessionId("run?a"));
expectTrue("runtime id length is bounded", toClineRuntimeSessionId(`background:${"x".repeat(200)}`).length <= 96);
expectTrue("Windows reserved name is prefixed", toClineRuntimeSessionId("CON").toLowerCase() !== "con");

const advisorBeforeTool = createBeforeToolHook({ permissionMode: "advisor", agentRole: "main" });
const allowedTickerHook = advisorBeforeTool({ snapshot: { agentRole: "main" }, tool: { name: "market.readTicker" } });
expectEqual("beforeTool allows advisor market reads", allowedTickerHook.policy?.enabled, true);
const blockedAdvisorTradeHook = advisorBeforeTool({ snapshot: { agentRole: "main" }, tool: { name: "trade.placeOrder" } });
expectEqual("beforeTool blocks advisor trading", blockedAdvisorTradeHook.skip, true);
const limitedAutoBeforeTool = createBeforeToolHook({ permissionMode: "limited_auto", agentRole: "main" });
const blockedSubagentTradeHook = limitedAutoBeforeTool({
  snapshot: { agentRole: "main", parentAgentId: "lead-agent" },
  tool: { name: "trade.placeOrder" }
});
expectEqual("beforeTool treats parented agent as subagent", blockedSubagentTradeHook.skip, true);

const enabled = { enabled: true, autoApprove: true };
const disabled = { enabled: false, autoApprove: false };

expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "market.readTicker", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "read_files", disabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "tradeOpportunity.list", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "tradeOpportunity.create", disabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "journal.createNote", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "trade.placeOrder", disabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "notification.feishu.send", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "intelligence.news.search", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "intelligence.smartMoney.readTraderPositions", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "intelligence.news.readMarketReaction", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "intelligence.smartMoney.readMarketPositioning", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main" }, "intelligence.smartMoney.readDerivativeDecisionContext", enabled);
expectEqual("news tools hidden without skill", isSkillToolEnabled("intelligence.news.list", []), false);
expectEqual("news tools exposed with skill", isSkillToolEnabled("intelligence.news.list", ["okx-news-intelligence"]), true);
expectEqual("smart money tools hidden without skill", isSkillToolEnabled("intelligence.smartMoney.readSignalTrendByFilter", []), false);
expectEqual("smart money tools exposed with skill", isSkillToolEnabled("intelligence.smartMoney.readSignalTrendByFilter", ["okx-smart-money-analysis"]), true);
expectEqual("news event tools hidden without skill", isSkillToolEnabled("intelligence.news.listEvents", []), false);
expectEqual("news event tools exposed with skill", isSkillToolEnabled("intelligence.news.readEvent", ["okx-news-intelligence"]), true);
expectEqual("derivatives evidence hidden without smart skill", isSkillToolEnabled("intelligence.smartMoney.readFundingBasis", []), false);
expectEqual("derivatives evidence exposed with smart skill", isSkillToolEnabled("intelligence.smartMoney.readFundingBasis", ["okx-smart-money-analysis"]), true);
expectEqual("derivative decision context exposed with smart skill", isSkillToolEnabled("intelligence.smartMoney.readDerivativeDecisionContext", ["okx-smart-money-analysis"]), true);

const briefingAdvisorPolicies = buildToolPolicies({ permissionMode: "advisor", agentRole: "main", backgroundRun: true });
expectEqual("briefing advisor can finish run", briefingAdvisorPolicies["background.finishRun"]?.enabled, true);
expectEqual("briefing advisor cannot create opportunities", briefingAdvisorPolicies["tradeOpportunity.create"]?.enabled, false);
expectEqual("briefing advisor cannot call trading tools", briefingAdvisorPolicies["trade.placeOrder"]?.enabled, false);
expectEqual("briefing advisor cannot synchronize leverage", briefingAdvisorPolicies["trade.setLeverage"]?.enabled, false);

expectPolicy({ permissionMode: "copilot", agentRole: "main" }, "tradeOpportunity.create", enabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main" }, "tradeOpportunity.revise", enabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main", backgroundRun: true }, "tradeOpportunity.revise", disabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main", backgroundRun: true }, "tradeOpportunity.reuse", disabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main", backgroundRun: true }, "tradeOpportunity.create", enabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main" }, "journal.createNote", enabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main" }, "trade.placeOrder", disabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main", backgroundRun: false }, "trade.setLeverage", disabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main", backgroundRun: true }, "trade.setLeverage", enabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main", backgroundRun: true }, "market.readDecisionContext", enabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main", backgroundRun: false }, "market.readDecisionContext", disabled);

expectPolicy({ permissionMode: "limited_auto", agentRole: "main" }, "tradeOpportunity.create", enabled);
expectPolicy({ permissionMode: "limited_auto", agentRole: "main", backgroundRun: true }, "tradeOpportunity.revise", disabled);
expectPolicy({ permissionMode: "limited_auto", agentRole: "main", backgroundRun: true }, "tradeOpportunity.reuse", disabled);
expectPolicy({ permissionMode: "limited_auto", agentRole: "main" }, "trade.placeOrder", disabled);
expectPolicy({ permissionMode: "limited_auto", agentRole: "main" }, "trade.closePosition", disabled);
expectPolicy({ permissionMode: "limited_auto", agentRole: "main", backgroundRun: true }, "trade.setLeverage", enabled);

for (const mode of ["advisor", "copilot", "limited_auto", "readonly", "approval", "full"]) {
  expectPolicy({ permissionMode: mode, agentRole: "main" }, "apply_patch", disabled);
  expectPolicy({ permissionMode: mode, agentRole: "main" }, "editor", disabled);
}

for (const agentRole of ["subagent", "team"]) {
  const config = {
    permissionMode: "limited_auto",
    agentRole,
    backgroundRun: true,
    reviewRun: true
  };
  expectPolicy(config, "market.readTicker", enabled);
  expectPolicy(config, "account.readPositions", enabled);
  expectPolicy(config, "intelligence.news.readEconomicCalendar", enabled);
  expectPolicy(config, "intelligence.smartMoney.readPerformanceByTrader", enabled);
  expectPolicy(config, "intelligence.news.readDailyBriefing", enabled);
  expectPolicy(config, "intelligence.smartMoney.readSystemStress", enabled);
  expectPolicy(config, "intelligence.smartMoney.readDerivativeDecisionContext", enabled);
  expectPolicy(config, "trade.precheck", enabled);
  expectPolicy(config, "market.readDecisionContext", disabled);
  expectPolicy(config, "tradeOpportunity.list", enabled);
  expectPolicy(config, "tradeOpportunity.create", disabled);
  expectPolicy(config, "journal.createNote", disabled);
  expectPolicy(config, "chart.createDrawing", disabled);
  expectPolicy(config, "alert.createPriceAlert", disabled);
  expectPolicy(config, "script.createOrUpdate", disabled);
  expectPolicy(config, "notification.feishu.send", disabled);
  expectPolicy(config, "background.finishRun", disabled);
  expectPolicy(config, "review.complete", disabled);
  expectPolicy(config, "review.readSkillVersion", disabled);
  expectPolicy(config, "optimizationSuggestion.create", disabled);
  expectPolicy(config, "trade.placeOrder", disabled);
  expectPolicy(config, "trade.setLeverage", disabled);
  expectPolicy(config, "spawn_agent", disabled);
  expectPolicy(config, "team_status", disabled);
}

expectPolicy({ permissionMode: "advisor", agentRole: "main", backgroundRun: false }, "background.finishRun", disabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main", backgroundRun: true }, "background.finishRun", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main", reviewRun: false }, "review.complete", disabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main", reviewRun: true }, "review.complete", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main", reviewRun: true }, "review.readSkillVersion", enabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main", reviewRun: true }, "optimizationSuggestion.create", enabled);

expectPolicy({ permissionMode: "advisor", agentRole: "main", enableSpawnAgent: false }, "spawn_agent", disabled);
expectPolicy({ permissionMode: "advisor", agentRole: "main", enableAgentTeams: false }, "team_status", disabled);
expectPolicy(
  { permissionMode: "limited_auto", agentRole: "main", disableSkillsTool: true },
  "skills",
  disabled
);
expectPolicy(
  { permissionMode: "advisor", agentRole: "main", toolAllowlist: ["script.createOrUpdate"] },
  "script.createOrUpdate",
  enabled
);
expectPolicy(
  { permissionMode: "advisor", agentRole: "main", toolAllowlist: ["script.createOrUpdate"] },
  "market.readTicker",
  disabled
);

const providerOpportunity = toProviderToolName("tradeOpportunity.create");
expectPolicy({ permissionMode: "copilot", agentRole: "main" }, providerOpportunity, enabled);
expectPolicy({ permissionMode: "copilot", agentRole: "main" }, "totally_unknown_tool", disabled);

const unknown = describeToolPolicy("totally_unknown_tool", { permissionMode: "limited_auto", agentRole: "main" });
if (!unknown.blocked || unknown.policy !== "disabled:unknown-tool") {
  failures.push(`unknown tool should be denied: ${JSON.stringify(unknown)}`);
}

const copilotTrade = describeToolPolicy("trade.placeOrder", { permissionMode: "copilot", agentRole: "main" });
if (!copilotTrade.blocked || copilotTrade.policy !== "disabled:ai-direct-trade-replaced-by-opportunity") {
  failures.push(`copilot direct trade should be denied: ${JSON.stringify(copilotTrade)}`);
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exit(1);
}

process.stdout.write("[policy] agent roles and permission modes ok\n");
