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
  // v3 Agent 库与 Profile 勾选（契约 C7 冻结键名；C15 已废弃 agentScopes 一族）。
  // 这些键由组件以 t("agentXxx") 直接引用（useTranslation(["automation","common"])，
  // 没有 automation: 前缀），上面的直接引用正则抓不到，因此按冻结清单逐字断言。
  "agents", "agentsEmpty", "agentsIntro", "createAgent", "createAgentWithAi",
  "agentName", "agentRole", "agentResponsibility", "agentSkills",
  "agentEnvelope", "agentEnvelopeStandard", "agentEnvelopeRisk",
  "agentSourceBuiltin", "agentSourceCustom", "agentSourceAi",
  "agentDuplicate", "agentDelete", "agentDeleteConfirm", "agentSave", "agentSaved",
  "agentBuiltinReadonly", "agentModified", "agentNeedsAccount", "agentMissingSkills",
  "agentEnabledProfiles", "agentGenerateHint", "agentGenerateAction", "agentGenerateFailed",
  // C16：创建对话框整改新增（Skills 多选、角色建议、草稿模型选择与生成来源）。
  "agentSkillsInactive", "agentMissingSkillsHint", "agentRoleSuggestions",
  "agentSkillsAdd", "agentSkillsSearch", "agentSkillsEmpty", "agentSkillsRemove", "agentModelMissing",
  "agentModelSelect", "agentModelHint", "agentGeneratedBy", "agentNoModels", "agentRegenerate",
  // C17：草稿生成过程卡片与流式（阶段/计时/字符数/取消）。
  "agentDraftProgressTitle", "agentDraftGenerating", "agentDraftCancel", "agentDraftCancelling",
  "agentDraftElapsedLabel", "agentDraftElapsed", "agentDraftCharsLabel", "agentDraftChars",
  "agentDraftModel", "agentDraftPhasePreparing", "agentDraftPhaseRequested",
  "agentDraftPhaseStreaming", "agentDraftPhaseFinalizing",
  "agentDraftStageCancelled", "agentDraftStageFailed",
  // C19：试判阶段（配置项 + 运行徽标/详情）。
  "runTriageDeepTokens",
  "runTriageEscalate",
  "runTriageForced",
  "runTriageSampled",
  "runTriageSkip",
  "runTriageTokens",
  "triageEscalateBreak",
  "triageEscalateNews",
  "triageEscalatePosition",
  "triageEscalateTitle",
  "triageIntro",
  "triageMarginRatio",
  "triageMarginRatioHint",
  "triageMaxSkips",
  "triageMaxSkipsHint",
  "triageMode",
  "triageModeEnforce",
  "triageModeEnforceHint",
  "triageModeOff",
  "triageModeOffHint",
  "triageModeShadow",
  "triageModeShadowHint",
  "triageRangeHint",
  "triageResonance",
  "triageResonanceHint",
  "triageSampleRate",
  "triageSampleRateHint",
  "triageSilence",
  "triageSilenceHint",
  "triageStopDistance",
  "triageStopDistanceHint",
  "triageTitle",
  "triageUnitCount",
  "triageUnitMinutes",
  "profileAgents", "profileAgentsHint", "profileAgentsEmpty", "profileAgentsSelectAll",
  "profileAgentsClear", "profileAgentEmptyStateHint"
];
for (const key of dynamicReferences) {
  assert(new RegExp(`(?:^|[,{\\s])${key}:`).test(resourceSource), `missing dynamically referenced i18n key ${key}`);
}
// `agentValidation_${code}` 是模板字面量家族（例如 agentValidation_id-conflict），
// 具体 code 由 Rust 校验结果决定，只能断言家族在 catalog 中存在。
assert.match(
  resourceSource,
  /(?:^|[,{\s"])agentValidation_[A-Za-z0-9_-]+["']?:/m,
  "missing agentValidation_* i18n key family (used by t(`agentValidation_${validation}`))"
);
assert.match(fs.readFileSync(path.join(root, "src/i18n/legacyBridge.ts"), "utf8"), /data-i18n-skip/);
assert.match(fs.readFileSync(path.join(root, "src/ui/AiMarkdown.tsx"), "utf8"), /data-i18n-skip/);
assert.match(fs.readFileSync(path.join(root, "src/ui/App.tsx"), "utf8"), /<p data-i18n-skip>\{message\.text\}<\/p>/);
assert.match(fs.readFileSync(path.join(root, "src/ui/ChartIndicatorCenter.tsx"), "utf8"), /<p data-i18n-skip>\{message\.text\}<\/p>/);
assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /config\/\*\.local\.json/);
console.log(`[i18n] locales=${expected.length} namespaces=9 direct=${directReferences.size} dynamic=${dynamicReferences.length} prompt-skill-ai-boundaries=verified`);
