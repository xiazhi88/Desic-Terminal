import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localeSource = fs.readFileSync(path.join(root, "src/i18n/locales.ts"), "utf8");
const resourceSource = fs.readFileSync(path.join(root, "src/i18n/resources.ts"), "utf8");

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

const locales = [...localeSource.matchAll(/"([a-z]{2}-[A-Z]{2})"/g)].map((match) => match[1]);
const expected = ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "de-DE", "fr-FR", "es-ES", "pt-BR", "ru-RU"];
assert.deepEqual([...new Set(locales)].slice(0, expected.length), expected);
for (const key of ["common", "navigation", "settings", "trading", "chart", "automation", "intelligence", "help", "errors"]) {
  assert.match(resourceSource, new RegExp(`${key}:\\s*\\{`), `missing namespace ${key}`);
}
for (const key of ["languageTitle", "languageDescription", "fallbackNotice", "quantityContracts", "priceUsdt", "noEvents"]) {
  assert.match(resourceSource, new RegExp(`${key}:`), `missing critical key ${key}`);
}
const directReferences = new Set();
for (const file of sourceFiles(path.join(root, "src"))) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bt\(\s*["'](?:common|navigation|settings|trading|chart|automation|intelligence|help|errors):([A-Za-z0-9_]+)["']/g)) {
    directReferences.add(match[1]);
  }
}
for (const key of directReferences) {
  assert(new RegExp(`(?:^|[,{\\s])${key}(?::|_one:)`).test(resourceSource), `missing directly referenced i18n key ${key}`);
}
const dynamicReferences = [
  "currentClosableSize", "currentOpenEstimate", "noClosablePosition", "waitingAccountBalance",
  "profileModeHintAdvisor", "profileModeHintCopilot", "profileModeHintLimitedAuto",
  "collaborationBuiltinAgentMarketStructureName", "collaborationBuiltinAgentMarketStructureRole", "collaborationBuiltinAgentMarketStructureResponsibility",
  "collaborationBuiltinAgentIntelligenceFlowName", "collaborationBuiltinAgentIntelligenceFlowRole", "collaborationBuiltinAgentIntelligenceFlowResponsibility",
  "collaborationBuiltinAgentAccountRiskName", "collaborationBuiltinAgentAccountRiskRole", "collaborationBuiltinAgentAccountRiskResponsibility",
  "collaborationBuiltinAgentContrarianReviewName", "collaborationBuiltinAgentContrarianReviewRole", "collaborationBuiltinAgentContrarianReviewResponsibility",
  "collaborationScopeMarket", "collaborationScopeDerivatives", "collaborationScopeIntelligence", "collaborationScopeAccount", "collaborationScopeHistory"
];
for (const key of dynamicReferences) {
  assert(new RegExp(`(?:^|[,{\\s])${key}:`).test(resourceSource), `missing dynamically referenced i18n key ${key}`);
}
assert.match(fs.readFileSync(path.join(root, "src/i18n/legacyBridge.ts"), "utf8"), /data-i18n-skip/);
assert.match(fs.readFileSync(path.join(root, "src/ui/AiMarkdown.tsx"), "utf8"), /data-i18n-skip/);
assert.match(fs.readFileSync(path.join(root, "src/ui/App.tsx"), "utf8"), /<p data-i18n-skip>\{message\.text\}<\/p>/);
assert.match(fs.readFileSync(path.join(root, "src/ui/ChartIndicatorCenter.tsx"), "utf8"), /<p data-i18n-skip>\{message\.text\}<\/p>/);
assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /config\/\*\.local\.json/);
console.log(`[i18n] locales=${expected.length} namespaces=9 direct=${directReferences.size} dynamic=${dynamicReferences.length} prompt-skill-ai-boundaries=verified`);
