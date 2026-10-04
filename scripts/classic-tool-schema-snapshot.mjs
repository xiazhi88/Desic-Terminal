// 经典模式（非交易员）侧车工具定义的快照：每个工具 = 描述 + 入参 schema 的 sha256。
// 交易员模式的改动只能在 traderMode 下生效；经典运行拿到的工具定义必须与快照逐字一致。
// 重新生成（仅在有意改动经典模式时）：node scripts/classic-tool-schema-snapshot.mjs --write
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createDesicTools, loadClineSdk } from "./cline-sidecar.mjs";

const FIXTURE = new URL("./fixtures/classic-tool-schemas.json", import.meta.url);

export const CLASSIC_SNAPSHOT_CONFIGS = {
  backgroundLimitedAuto: { permissionMode: "limited_auto", agentRole: "main", backgroundRun: true, agentProfileId: "p", agentRunId: "r", enabledSkills: ["okx-market-intelligence", "market-radar-research"] },
  backgroundCopilot: { permissionMode: "copilot", agentRole: "main", backgroundRun: true, agentProfileId: "p", agentRunId: "r" },
  reviewRun: { permissionMode: "advisor", agentRole: "main", backgroundRun: true, reviewRun: true, reviewId: "review:e:1", episodeId: "e" },
  interactiveResearch: { permissionMode: "advisor", agentRole: "main", strategySessionKind: "trading-research" }
};

export async function classicToolSchemaHashes() {
  await loadClineSdk();
  const out = {};
  for (const [key, config] of Object.entries(CLASSIC_SNAPSHOT_CONFIGS)) {
    const tools = createDesicTools("snapshot", config).filter(Boolean);
    out[key] = Object.fromEntries(tools.map((tool) => [
      tool.name,
      createHash("sha256").update(JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema })).digest("hex").slice(0, 16)
    ]));
  }
  return out;
}

export function readClassicToolSchemaFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

if (process.argv.includes("--write")) {
  writeFileSync(FIXTURE, `${JSON.stringify(await classicToolSchemaHashes(), null, 1)}\n`);
  console.log("classic tool schema snapshot written");
}
