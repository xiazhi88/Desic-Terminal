import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  AI_BUILT_IN_PROVIDER_IDS,
  AI_RECOMMENDED_PROVIDER_IDS,
  aiProviderCatalogOptions,
  aiRecommendedProviderOptions,
  findAiProviderCatalogEntry,
  isBuiltInProviderId
} from "../src/lib/aiProviderCatalog.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";

// 1) The shipped list must match the installed Cline SDK, so a Provider id this
//    UI offers can never be one the runtime does not know.
const sdk = await import("@cline/llms");
const sdkIds = new Set(Object.values(sdk.BUILT_IN_PROVIDER).map((id) => String(id).toLowerCase()));
assert.ok(sdkIds.size > 20, `expected a populated SDK provider enum, got ${sdkIds.size}`);
for (const entry of AI_BUILT_IN_PROVIDER_IDS) {
  assert.ok(
    sdkIds.has(entry.id.toLowerCase()),
    `catalog id "${entry.id}" is not a built-in @cline/llms provider`
  );
}

// 2) No duplicates, and every entry carries a human label.
const seen = new Set();
for (const entry of AI_BUILT_IN_PROVIDER_IDS) {
  const key = entry.id.toLowerCase();
  assert.ok(!seen.has(key), `duplicate catalog id ${entry.id}`);
  seen.add(key);
  assert.ok(entry.label.trim().length > 0, `${entry.id} needs a label`);
  assert.ok(entry.description.trim().length > 0, `${entry.id} needs a description`);
}

// 3) The ids this app's own templates write must be offered by the catalog too,
//    otherwise the dropdown and the template path would disagree.
const flowSource = await readFile(path.join(repoRoot, "src/ui/AiProviderSetupFlow.tsx"), "utf8");
const templateProviders = [...flowSource.matchAll(/^\s{4}provider: "([^"]+)",$/gm)].map((match) => match[1]);
assert.ok(templateProviders.length >= 10, `expected template providers, found ${templateProviders.length}`);
for (const provider of templateProviders) {
  assert.ok(
    isBuiltInProviderId(provider),
    `template provider "${provider}" is missing from the Provider catalog`
  );
}

// 4) Lookup helpers agree with the list.
assert.equal(findAiProviderCatalogEntry("  OpenAI-Native ")?.id, "openai-native");
assert.equal(findAiProviderCatalogEntry("not-a-real-provider"), null);
assert.ok(isBuiltInProviderId("OPENAI-COMPATIBLE"));
assert.equal(isBuiltInProviderId("gpt-5.6-terra"), false, "a model id is not a provider id");

// 5) The default dropdown is the short protocol-oriented list, not the full SDK
//    catalog, and the two protocols a custom endpoint actually chooses between
//    must both be reachable there.
const short = aiRecommendedProviderOptions();
assert.ok(short.length <= 8, `the default Provider list must stay short, got ${short.length}`);
for (const id of ["openai-compatible", "openai-native", "anthropic", "gemini"]) {
  assert.ok(short.some((option) => option.value === id), `${id} must be in the short list`);
}
assert.equal(short[0].value, "openai-compatible", "the generic compatible endpoint comes first");
for (const option of short) {
  assert.ok(
    isBuiltInProviderId(option.value),
    `short-list id ${option.value} must be a built-in SDK provider`
  );
  assert.ok(
    option.description.includes(option.value),
    `short-list option ${option.value} must keep the raw id visible`
  );
}
assert.deepEqual(
  short.map((option) => option.value).slice(0, AI_RECOMMENDED_PROVIDER_IDS.length),
  [...AI_RECOMMENDED_PROVIDER_IDS],
  "the short list keeps the declared order"
);

const full = aiProviderCatalogOptions();
assert.equal(full.length, AI_BUILT_IN_PROVIDER_IDS.length, "the full list carries every catalog entry");
assert.deepEqual(
  full.slice(0, short.length).map((option) => option.value),
  short.map((option) => option.value),
  "the full list keeps the short list at the top"
);
assert.equal(
  new Set(full.map((option) => option.value)).size,
  full.length,
  "expanding must not duplicate options"
);
assert.ok(full.every((option) => option.description.includes(option.value)));

console.log(
  `ai provider catalog: ok (${AI_BUILT_IN_PROVIDER_IDS.length} built-in providers, ${short.length} shown by default, ${templateProviders.length} template providers verified against @cline/llms)`
);
