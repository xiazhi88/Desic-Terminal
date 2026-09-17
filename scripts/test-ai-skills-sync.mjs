import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CANONICAL_REQUIRED_AI_SKILL_IDS = [
  "desic-core-operations",
  "trading-philosophy",
  "okx-market-intelligence",
  "market-radar-research",
  "desic-trade-operations",
  "desic-agent-orchestration"
];
const CANONICAL_REQUIRED_ENABLED_AI_SKILL_IDS = CANONICAL_REQUIRED_AI_SKILL_IDS.filter(
  (id) => id !== "desic-core-operations"
);
const IMPLICIT_FIXED_SKILL_ID = "desic-core-operations";

function parseQuotedIds(source) {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function extractQuotedArray(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label}: declaration not found`);
  const ids = parseQuotedIds(match[1]);
  assert.ok(ids.length > 0, `${label}: no quoted ids parsed`);
  return ids;
}

async function readRepoFile(relativePath) {
  return readFile(path.resolve(repoRoot, relativePath), "utf8");
}

async function main() {
  assert.equal(
    new Set(CANONICAL_REQUIRED_AI_SKILL_IDS).size,
    CANONICAL_REQUIRED_AI_SKILL_IDS.length,
    "canonical required skill ids must not contain duplicates"
  );

  const appSource = await readRepoFile("src/ui/App.tsx");

  const requiredIds = extractQuotedArray(
    appSource,
    /const REQUIRED_AI_SKILL_IDS = \[([\s\S]*?)\] as const;/,
    "src/ui/App.tsx REQUIRED_AI_SKILL_IDS"
  );
  assert.deepEqual(
    requiredIds,
    CANONICAL_REQUIRED_AI_SKILL_IDS,
    "src/ui/App.tsx REQUIRED_AI_SKILL_IDS must equal the canonical 6-skill set (content and order)"
  );

  const enabledMatch = appSource.match(
    /const REQUIRED_ENABLED_AI_SKILL_IDS(?::[^=]+)? = REQUIRED_AI_SKILL_IDS\.filter\(([\s\S]*?)\);/
  );
  assert.ok(
    enabledMatch,
    "src/ui/App.tsx REQUIRED_ENABLED_AI_SKILL_IDS must be derived from REQUIRED_AI_SKILL_IDS via filter"
  );
  const enabledIds = new Function(
    "list",
    `return list.filter(${enabledMatch[1]});`
  )(requiredIds);
  assert.deepEqual(
    enabledIds,
    CANONICAL_REQUIRED_ENABLED_AI_SKILL_IDS,
    "src/ui/App.tsx REQUIRED_ENABLED_AI_SKILL_IDS must equal the canonical set minus desic-core-operations"
  );
  assert.ok(
    !enabledIds.includes(IMPLICIT_FIXED_SKILL_ID),
    "REQUIRED_ENABLED_AI_SKILL_IDS must not contain the implicit fixed skill"
  );

  const storageConfigSource = await readRepoFile("src-tauri/crates/storage-config/src/lib.rs");
  const rustRequiredIds = extractQuotedArray(
    storageConfigSource,
    /pub const REQUIRED_AI_SKILL_IDS:\s*\[&str; \d+\] = \[([\s\S]*?)\];/,
    "storage-config REQUIRED_AI_SKILL_IDS"
  );
  assert.deepEqual(
    rustRequiredIds,
    CANONICAL_REQUIRED_AI_SKILL_IDS,
    "storage-config REQUIRED_AI_SKILL_IDS must equal the canonical 6-skill set"
  );

  const enabledFnMatch = storageConfigSource.match(
    /fn default_ai_enabled_skills\(\)[^{]*\{([\s\S]*?)\n\}/
  );
  assert.ok(enabledFnMatch, "storage-config default_ai_enabled_skills not found");
  assert.ok(
    enabledFnMatch[1].includes("REQUIRED_AI_SKILL_IDS"),
    "default_ai_enabled_skills must derive from REQUIRED_AI_SKILL_IDS"
  );
  assert.match(
    enabledFnMatch[1],
    /filter\(\|id\| \*id != "desic-core-operations"\)/,
    "default_ai_enabled_skills must exclude the implicit fixed skill"
  );

  const aiAutomationSource = await readRepoFile("src-tauri/src/ai_automation.rs");
  const rustProfileIds = extractQuotedArray(
    aiAutomationSource,
    /const REQUIRED_PROFILE_SKILL_IDS:\s*\[&str; \d+\] = \[([\s\S]*?)\];/,
    "ai_automation REQUIRED_PROFILE_SKILL_IDS"
  );
  assert.deepEqual(
    rustProfileIds,
    CANONICAL_REQUIRED_AI_SKILL_IDS,
    "ai_automation REQUIRED_PROFILE_SKILL_IDS must equal the canonical 6-skill set"
  );

  const aiAutomationPanelSource = await readRepoFile("src/ui/AiAutomationPanel.tsx");
  const tsProfileIds = extractQuotedArray(
    aiAutomationPanelSource,
    /const REQUIRED_PROFILE_SKILL_IDS = \[([\s\S]*?)\] as const;/,
    "src/ui/AiAutomationPanel.tsx REQUIRED_PROFILE_SKILL_IDS"
  );
  assert.deepEqual(
    tsProfileIds,
    CANONICAL_REQUIRED_AI_SKILL_IDS,
    "src/ui/AiAutomationPanel.tsx REQUIRED_PROFILE_SKILL_IDS must equal the canonical 6-skill set"
  );

  const smokeSource = await readRepoFile("scripts/smoke-terminal-preview.mjs");
  const smokeRequiredIds = extractQuotedArray(
    smokeSource,
    /const required = \[([^\]]*desic-core-operations[^\]]*)\];/,
    "smoke-terminal-preview required skill list"
  );
  assert.deepEqual(
    smokeRequiredIds,
    CANONICAL_REQUIRED_AI_SKILL_IDS,
    "smoke-terminal-preview required skill list must cover the canonical 6-skill set"
  );

  console.log(
    `ai-skills-sync ok: ${CANONICAL_REQUIRED_AI_SKILL_IDS.length} required skills (${CANONICAL_REQUIRED_ENABLED_AI_SKILL_IDS.length} enabled) locked across App.tsx, AiAutomationPanel, storage-config, ai_automation and smoke-terminal-preview`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
