import { readFile } from "node:fs/promises";

export async function loadAiSmokeConfig() {
  const config = JSON.parse(await readFile(new URL("../config/ai.local.json", import.meta.url), "utf8"));
  const apiKey = process.env.DESIC_AI_API_KEY || process.env.DEEPSEEK_API_KEY || config.apiKey || "";
  return {
    ...config,
    provider: process.env.DESIC_AI_PROVIDER || config.provider || "deepseek",
    model: process.env.DESIC_AI_MODEL || config.model || "deepseek-v4-pro",
    baseUrl: process.env.DESIC_AI_BASE_URL || config.baseUrl || "https://api.deepseek.com/v1",
    apiKey,
    permissionMode: process.env.DESIC_AI_PERMISSION_MODE || config.permissionMode || "readonly"
  };
}

export function assertAiSmokeConfig(config) {
  const missing = [];
  if (!String(config.model || "").trim()) missing.push("model");
  if (!String(config.baseUrl || "").trim()) missing.push("baseUrl");
  if (!String(config.apiKey || "").trim()) missing.push("apiKey");
  if (missing.length) {
    throw new Error(
      `AI smoke config missing ${missing.join(", ")}. Set DESIC_AI_API_KEY or save an AI key before running real sidecar smoke tests.`
    );
  }
}
