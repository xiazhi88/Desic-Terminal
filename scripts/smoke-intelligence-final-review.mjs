import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveToolPolicy } from "./cline-tool-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [sidecar, intelligence, tradeCommands, automation, symbolIcon, tauriLib, intelligencePage, app] = await Promise.all([
  readFile(resolve(root, "scripts/cline-sidecar.mjs"), "utf8"),
  readFile(resolve(root, "src-tauri/src/intelligence.rs"), "utf8"),
  readFile(resolve(root, "src-tauri/src/trade_commands.rs"), "utf8"),
  readFile(resolve(root, "src-tauri/src/ai_automation.rs"), "utf8"),
  readFile(resolve(root, "src/ui/SymbolIcon.tsx"), "utf8"),
  readFile(resolve(root, "src-tauri/src/lib.rs"), "utf8"),
  readFile(resolve(root, "src/ui/IntelligencePage.tsx"), "utf8"),
  readFile(resolve(root, "src/ui/App.tsx"), "utf8")
]);

assert.match(sidecar, /tool\("market\.readDecisionContext"/);
assert.match(sidecar, /finalDecision/);
assert.match(sidecar, /不得使用 size=0/);
assert.match(sidecar, /若结论是 wait 或 abandon 且本轮没有新交易候选/);
assert.match(automation, /不得使用 size=0/);
assert.match(automation, /由主 Agent 独立完成证据分析/);
assert.match(symbolIcon, /ensure_market_icon_data_url/);
assert.match(tauriLib, /async fn ensure_market_icon_data_url/);
assert.doesNotMatch(intelligencePage, /交给 AI 分析/);
assert.doesNotMatch(app, /desic:analyze-intelligence/);
const intelligenceSchemas = sidecar.slice(
  sidecar.indexOf("const INTELLIGENCE_NEWS_SCHEMA"),
  sidecar.indexOf("const JOURNAL_NOTE_SCHEMA")
);
assert.ok(!/localOnly\s*:/.test(intelligenceSchemas), "Agent intelligence schemas must not expose localOnly");

assert.equal(resolveToolPolicy("market.readDecisionContext", {
  permissionMode: "copilot",
  agentRole: "main",
  backgroundRun: true
}).allowed, true);
assert.equal(resolveToolPolicy("market.readDecisionContext", {
  permissionMode: "limited_auto",
  agentRole: "subagent",
  backgroundRun: true
}).allowed, false);

assert.match(intelligence, /object\.insert\("localOnly"\.to_string\(\), json!\(true\)\)/);
assert.match(intelligence, /queue_agent_intelligence_refresh/);
assert.match(intelligence, /buffer_unordered\(3\)/);
assert.match(intelligence, /refresh_inflight/);

assert.match(tradeCommands, /const DECISION_CONTEXT_TTL_MS: i64 = 60_000/);
assert.match(tradeCommands, /saturating_add\(DECISION_CONTEXT_TTL_MS\)/);
assert.match(tradeCommands, /decision_context_candidate_mismatch/);
assert.match(tradeCommands, /decision_context_scope_mismatch/);
assert.match(tradeCommands, /consumed_opportunity_id/);

console.log("Intelligence localization and final-review smoke checks passed.");
