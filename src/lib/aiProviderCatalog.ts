/**
 * Built-in Cline SDK provider IDs, mirroring `BUILT_IN_PROVIDER` in
 * `@cline/llms`. The Provider field accepts a free string, so this list exists
 * to make the common case a choice instead of a memorised identifier, not to
 * reject anything.
 *
 * Re-check against the SDK after an `@cline/llms` upgrade:
 *   node -e "import('@cline/llms').then(m=>console.log(Object.values(m.BUILT_IN_PROVIDER).join('\n')))"
 * `scripts/test-ai-provider-catalog.mjs` fails when a template provider or a
 * catalog id drifts from the installed SDK.
 */
export const AI_PROVIDER_CATALOG_ID = "cline-sdk-builtin-providers";

export type AiProviderCatalogEntry = Readonly<{
  id: string;
  /** Short Chinese label; the id itself is what gets written to the config. */
  label: string;
  description: string;
  /** Shown in the short list; everything else stays behind "show all". */
  recommended?: boolean;
}>;

/**
 * Vendors are not protocols: almost every gateway and non-OpenAI vendor is
 * reached through one of these, so the short list is what the form shows first
 * and the remaining entries stay reachable on demand.
 *
 * Order matters: the generic OpenAI-compatible endpoint is what a custom
 * connection needs most often.
 */
export const AI_RECOMMENDED_PROVIDER_IDS: readonly string[] = [
  "openai-compatible",
  "openai-native",
  "anthropic",
  "gemini",
  "ollama",
  "lmstudio"
];

export const AI_BUILT_IN_PROVIDER_IDS: readonly AiProviderCatalogEntry[] = [
  { id: "openai-compatible", label: "OpenAI 兼容（Chat Completions）", description: "绝大多数厂商与中转：/v1/chat/completions", recommended: true },
  { id: "openai-native", label: "OpenAI Responses", description: "OpenAI 官方与支持 /v1/responses 的网关", recommended: true },
  { id: "anthropic", label: "Anthropic Messages", description: "Claude 官方与 Anthropic 协议网关", recommended: true },
  { id: "gemini", label: "Google Gemini", description: "Gemini 原生协议", recommended: true },
  { id: "ollama", label: "Ollama", description: "本机或自建 Ollama", recommended: true },
  { id: "lmstudio", label: "LM Studio", description: "本机 LM Studio 服务", recommended: true },
  { id: "xai", label: "xAI", description: "Grok 的 OpenAI 兼容接口" },
  { id: "deepseek", label: "DeepSeek", description: "DeepSeek 原生接口" },
  { id: "qwen", label: "通义千问", description: "阿里云百炼接口" },
  { id: "qwen-code", label: "通义千问 Coder", description: "百炼编码模型接口" },
  { id: "moonshot", label: "Moonshot / KIMI", description: "Kimi 开放平台接口" },
  { id: "doubao", label: "豆包", description: "火山方舟接口" },
  { id: "minimax", label: "MiniMax", description: "MiniMax 接口" },
  { id: "zai", label: "智谱 ZAI", description: "GLM 接口" },
  { id: "zai-coding-plan", label: "智谱编码套餐", description: "GLM Coding Plan 订阅通道" },
  { id: "mistral", label: "Mistral", description: "Mistral 接口" },
  { id: "xiaomi", label: "小米 MiMo", description: "MiMo 接口" },
  { id: "tencent-tokenhub", label: "腾讯 TokenHub", description: "腾讯混元通道" },
  { id: "huawei-cloud-maas", label: "华为云 MaaS", description: "华为云模型服务" },
  { id: "sapaicore", label: "SAP AI Core", description: "SAP 企业模型网关" },
  { id: "oca", label: "OCA", description: "OCA 通道" },
  { id: "asksage", label: "AskSage", description: "AskSage 通道" },
  { id: "litellm", label: "LiteLLM", description: "自建 LiteLLM 代理（Responses 协议）" },
  { id: "openrouter", label: "OpenRouter", description: "聚合路由" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", description: "Vercel 聚合网关" },
  { id: "requesty", label: "Requesty", description: "聚合路由" },
  { id: "together", label: "Together AI", description: "开源模型托管" },
  { id: "fireworks", label: "Fireworks AI", description: "开源模型托管" },
  { id: "groq", label: "Groq", description: "低延迟推理" },
  { id: "cerebras", label: "Cerebras", description: "低延迟推理" },
  { id: "sambanova", label: "SambaNova", description: "低延迟推理" },
  { id: "nebius", label: "Nebius", description: "欧洲云推理" },
  { id: "baseten", label: "Baseten", description: "模型托管" },
  { id: "poolside", label: "Poolside", description: "编码模型" },
  { id: "huggingface", label: "Hugging Face", description: "模型托管" },
  { id: "wandb", label: "Weights & Biases", description: "推理网关" },
  { id: "aihubmix", label: "AIHubMix", description: "聚合路由" },
  { id: "hicap", label: "HiCap", description: "聚合路由" },
  { id: "kilo", label: "Kilo Gateway", description: "Kilo 网关（Responses 协议）" },
  { id: "v0", label: "v0", description: "v0 通道" },
  { id: "nousResearch", label: "Nous Research", description: "Nous 通道" },
  { id: "dify", label: "Dify", description: "Dify 应用接口（AI SDK 适配层）" },
  { id: "bedrock", label: "Amazon Bedrock", description: "AWS 托管模型" },
  { id: "vertex", label: "Google Vertex AI", description: "GCP 托管模型" },
  { id: "cline", label: "Cline 用量计费", description: "Cline 官方计费端点" },
  { id: "cline-pass", label: "ClinePass", description: "Cline 订阅模型" },
  { id: "openai-codex-cli", label: "本机 Codex CLI", description: "委托本机 codex CLI，不走 API Key" },
  { id: "openai-codex", label: "Codex 账号", description: "Codex 账号通道" },
  { id: "claude-code", label: "本机 Claude Code", description: "委托本机 claude CLI，不走 API Key" },
  { id: "opencode", label: "OpenCode", description: "OpenCode 通道" }
];

const AI_BUILT_IN_PROVIDER_ID_SET = new Set(AI_BUILT_IN_PROVIDER_IDS.map((entry) => entry.id.toLowerCase()));

export function isBuiltInProviderId(provider: string): boolean {
  return AI_BUILT_IN_PROVIDER_ID_SET.has(provider.trim().toLowerCase());
}

export function findAiProviderCatalogEntry(provider: string): AiProviderCatalogEntry | null {
  const normalized = provider.trim().toLowerCase();
  return AI_BUILT_IN_PROVIDER_IDS.find((entry) => entry.id.toLowerCase() === normalized) ?? null;
}

function toOption(entry: AiProviderCatalogEntry): { value: string; label: string; description: string } {
  return {
    value: entry.id,
    label: entry.label,
    // Keep the raw id in the description: it is what the config stores.
    description: `${entry.id} · ${entry.description}`
  };
}

const AI_RECOMMENDED_PROVIDER_ID_SET = new Set(AI_RECOMMENDED_PROVIDER_IDS.map((id) => id.toLowerCase()));

/** The short list shown by default, in the declared order. */
export function aiRecommendedProviderOptions(): Array<{ value: string; label: string; description: string }> {
  return AI_RECOMMENDED_PROVIDER_IDS
    .map((id) => AI_BUILT_IN_PROVIDER_IDS.find((entry) => entry.id.toLowerCase() === id.toLowerCase()))
    .filter((entry): entry is AiProviderCatalogEntry => Boolean(entry))
    .map(toOption);
}

/** The same short list first, then every other built-in provider. */
export function aiProviderCatalogOptions(): Array<{ value: string; label: string; description: string }> {
  return [
    ...aiRecommendedProviderOptions(),
    ...AI_BUILT_IN_PROVIDER_IDS.filter((entry) => !AI_RECOMMENDED_PROVIDER_ID_SET.has(entry.id.toLowerCase()))
      .map(toOption)
  ];
}
