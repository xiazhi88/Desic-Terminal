import clsx from "clsx";
import { ArrowLeft, Check, CircleAlert, Copy, ExternalLink, KeyRound, Laptop, RefreshCw, ServerCog, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiLocalCliStatus } from "../types";
import { loadAiLocalAuthStatus } from "../lib/ai";
import openaiIcon from "../assets/ai-providers/openai.svg";
import anthropicIcon from "../assets/ai-providers/anthropic.svg";
import geminiIcon from "../assets/ai-providers/gemini.svg";
import xaiIcon from "../assets/ai-providers/xai.svg";
import deepseekIcon from "../assets/ai-providers/deepseek.svg";
import qwenIcon from "../assets/ai-providers/qwen.svg";
import kimiIcon from "../assets/ai-providers/kimi.svg";
import doubaoIcon from "../assets/ai-providers/doubao.svg";
import minimaxIcon from "../assets/ai-providers/minimax.svg";
import zhipuIcon from "../assets/ai-providers/zhipu.svg";
import { TerminalSelect, type TerminalSelectOption } from "./TerminalSelect";
import "./AiProviderSetupFlow.css";

export type AiProviderTemplateId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "xai"
  | "deepseek"
  | "qwen"
  | "kimi"
  | "doubao"
  | "minimax"
  | "zhipu"
  | "custom";

export type AiProviderTemplate = Readonly<{
  id: AiProviderTemplateId;
  name: string;
  company: string;
  description: string;
  provider: string;
  baseUrl: string;
  icon?: string;
  modelOptions: readonly TerminalSelectOption[];
}>;

export type AiProviderAccessGuide = Readonly<{
  url: string;
  linkLabel: string;
  steps: readonly string[];
  note?: string;
}>;

type AiLocalConnectionTemplate = Readonly<{
  provider: "openai-codex-cli" | "claude-code";
  name: string;
  baseUrl: string;
  loginCommand: string;
  guide: AiProviderAccessGuide;
}>;

export type AiProviderSetupValue = Readonly<{
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}>;

const CUSTOM_MODEL_VALUE = "__custom_model_id__";

export const AI_PROVIDER_GUIDES: Partial<Record<AiProviderTemplateId, AiProviderAccessGuide>> = {
  openai: {
    url: "https://platform.openai.com/api-keys",
    linkLabel: "打开 OpenAI API Keys",
    steps: ["在 OpenAI Platform 创建项目 API Key。", "确认项目已配置账单与调用额度，再回到此处粘贴 Key。"],
    note: "ChatGPT 订阅与 OpenAI API 账单相互独立。",
  },
  anthropic: {
    url: "https://console.anthropic.com/settings/keys",
    linkLabel: "打开 Anthropic Console",
    steps: ["在 Anthropic Console 创建 API Key。", "确认 Workspace 已有可用额度，并将 Key 填入当前配置。"],
    note: "Claude App / Claude Code 订阅不能作为 Anthropic API Key。",
  },
  gemini: {
    url: "https://aistudio.google.com/apikey",
    linkLabel: "打开 Google AI Studio",
    steps: ["在 Google AI Studio 创建 Gemini API Key。", "选择对应 Google Cloud 项目，并将 Key 填入当前配置。"],
    note: "为遵守 Gemini CLI 条款，本应用不读取或复用 Gemini CLI OAuth。",
  },
  xai: {
    url: "https://console.x.ai/",
    linkLabel: "打开 xAI Console",
    steps: ["在 xAI Console 创建 API Key。", "确认团队账单和模型权限后，将 Key 填入当前配置。"],
    note: "xAI 公共推理 API 当前使用 API Key；企业 OIDC 不等同于通用第三方 OAuth。",
  },
  deepseek: {
    url: "https://platform.deepseek.com/api_keys",
    linkLabel: "打开 DeepSeek API Keys",
    steps: ["登录 DeepSeek 开放平台并创建 API Key。", "确认账户余额和模型可用后，将 Key 填入当前配置。"],
  },
  qwen: {
    url: "https://platform.qianwenai.com/home",
    linkLabel: "打开通义千问平台",
    steps: ["登录平台并开通所需模型服务。", "创建 API Key 后，将 Key 填入当前配置。"],
  },
  kimi: {
    url: "https://platform.kimi.com/console/account",
    linkLabel: "打开 Kimi 开放平台",
    steps: ["进入 Kimi 开放平台账户页。", "创建 API Key 并确认账户额度后，将 Key 填入当前配置。"],
  },
  doubao: {
    url: "https://console.volcengine.com/ark/region:cn-beijing/openManagement",
    linkLabel: "打开火山方舟控制台",
    steps: ["在开通管理中启用准备使用的豆包模型。", "进入 API Key 管理创建 Key，再回到此处完成配置。"],
    note: "Model ID 必须与已开通的模型或推理接入点一致。",
  },
  minimax: {
    url: "https://platform.minimaxi.com/console/access",
    linkLabel: "打开 MiniMax 请求管理",
    steps: ["在请求管理中创建 API Key。", "确认按量计费或套餐资源可用后，将 Key 填入当前配置。"],
  },
  zhipu: {
    url: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    linkLabel: "打开智谱 API Keys",
    steps: ["在智谱开放平台创建项目 API Key。", "确认模型权限和余额后，将 Key 填入当前配置。"],
  },
};

const AI_LOCAL_CONNECTIONS: Partial<Record<AiProviderTemplateId, AiLocalConnectionTemplate>> = {
  openai: {
    provider: "openai-codex-cli",
    name: "本机 Codex",
    baseUrl: "local://codex-cli",
    loginCommand: "codex login",
    guide: {
      url: "https://github.com/openai/codex#authentication",
      linkLabel: "查看 Codex 官方认证说明",
      steps: ["安装官方 Codex CLI，并在终端运行 codex login。", "本应用检测登录状态后，所有请求交由本机 Codex CLI 执行。"],
      note: "不会读取 ~/.codex/auth.json，也不会复制或保存 OAuth Token。",
    },
  },
  anthropic: {
    provider: "claude-code",
    name: "本机 Claude Code",
    baseUrl: "local://claude-code",
    loginCommand: "claude auth login",
    guide: {
      url: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
      linkLabel: "查看 Claude Code 官方说明",
      steps: ["安装官方 Claude Code，并在终端运行 claude auth login。", "本应用检测登录状态后，通过官方 Claude Code CLI 非交互模式委托请求。"],
      note: "本应用不会直接读取系统钥匙串、配置文件或 OAuth Token；路由与认证由官方 CLI 自行加载。",
    },
  },
};

export const AI_PROVIDER_TEMPLATES: readonly AiProviderTemplate[] = [
  {
    id: "openai",
    name: "OpenAI",
    company: "OpenAI API",
    description: "API Key 或本机 Codex 委托",
    provider: "openai-native",
    baseUrl: "https://api.openai.com/v1",
    icon: openaiIcon,
    modelOptions: [
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "推荐 · 智能、成本与速度平衡" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "最新旗舰 · 复杂推理与编码" },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", description: "高频、低成本任务" },
      { value: "gpt-5.6", label: "GPT-5.6", description: "官方别名 · 当前指向 GPT-5.6 Sol" },
      { value: "gpt-5.5", label: "GPT-5.5", description: "高质量通用与 Agent 任务" },
      { value: "gpt-5.5-pro", label: "GPT-5.5 Pro", description: "高成本 · Responses API 深度推理" },
      { value: "gpt-5.4", label: "GPT-5.4", description: "成熟的专业工作模型" },
      { value: "gpt-5.4-pro", label: "GPT-5.4 Pro", description: "高成本 · Responses API" },
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "轻量 Agent 与子任务" },
      { value: "gpt-5.4-nano", label: "GPT-5.4 Nano", description: "分类、提取与批量轻任务" },
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", description: "专用编码 Agent 模型" },
    ],
  },
  {
    id: "anthropic",
    name: "Claude",
    company: "Anthropic API",
    description: "API Key 或本机 Claude Code 委托",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    icon: anthropicIcon,
    modelOptions: [
      { value: "claude-sonnet-5", label: "Claude Sonnet 5", description: "推荐 · 速度与智能平衡" },
      { value: "claude-fable-5", label: "Claude Fable 5", description: "最新最高能力 · 长程 Agent" },
      { value: "claude-opus-5", label: "Claude Opus 5", description: "最新 · 复杂编码与企业 Agent" },
      { value: "claude-opus-4-8", label: "Claude Opus 4.8", description: "成熟复杂推理与 Agent 编排" },
      { value: "claude-opus-4-7", label: "Claude Opus 4.7", description: "复杂编码与企业任务" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", description: "稳定的 Agent 模型" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", description: "快速轻量任务" },
    ],
  },
  {
    id: "gemini",
    name: "Gemini",
    company: "Google",
    description: "Google Gemini 原生 API",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    icon: geminiIcon,
    modelOptions: [
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash", description: "推荐 · Agent 与多模态" },
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash", description: "稳定高性能" },
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", description: "最新轻量 · 高频自动化" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", description: "复杂推理预览版" },
      { value: "gemini-3.1-pro-preview-customtools", label: "Gemini 3.1 Pro Custom Tools", description: "预览版 · 强化自定义工具调用" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", description: "稳定轻量模型" },
      { value: "gemini-flash-latest", label: "Gemini Flash Latest", description: "滚动别名 · 自动指向最新 Flash" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", description: "成熟通用模型" },
    ],
  },
  {
    id: "xai",
    name: "Grok",
    company: "xAI",
    description: "xAI OpenAI 兼容 API",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    icon: xaiIcon,
    modelOptions: [
      { value: "grok-4.5", label: "Grok 4.5", description: "推荐 · 最新通用推理" },
      { value: "grok-4.3", label: "Grok 4.3", description: "稳定通用模型" },
      { value: "grok-build-0.1", label: "Grok Build 0.1", description: "Agent 与编码任务" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    company: "深度求索",
    description: "DeepSeek V4 原生 API",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    icon: deepseekIcon,
    modelOptions: [
      { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro", description: "推荐 · 复杂推理与 Agent" },
      { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash", description: "低延迟与高性价比" },
    ],
  },
  {
    id: "qwen",
    name: "通义千问",
    company: "阿里云百炼",
    description: "中国大陆百炼兼容接口",
    provider: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    icon: qwenIcon,
    modelOptions: [
      { value: "qwen3.7-plus", label: "Qwen3.7 Plus", description: "推荐 · Agent、工具调用与 1M 上下文" },
      { value: "qwen3.7-max", label: "Qwen3.7 Max", description: "旗舰复杂推理任务" },
      { value: "qwen3.7-flash", label: "Qwen3.7 Flash", description: "最新轻量 · 高频低延迟任务" },
      { value: "qwen3.6-flash", label: "Qwen3.6 Flash", description: "高频低延迟任务" },
      { value: "qwen3-coder-plus", label: "Qwen3 Coder Plus", description: "1M 上下文编码 Agent" },
      { value: "qwen3-coder-next", label: "Qwen3 Coder Next", description: "新一代编码与工具调用" },
      { value: "qwen-long", label: "Qwen Long", description: "超长文档 · 10M 上下文" },
    ],
  },
  {
    id: "kimi",
    name: "KIMI",
    company: "Moonshot AI",
    description: "Kimi 开放平台 API",
    provider: "moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    icon: kimiIcon,
    modelOptions: [
      { value: "kimi-k2.6", label: "Kimi K2.6", description: "推荐 · Agent 与长上下文" },
      { value: "kimi-k2.7-code", label: "Kimi K2.7 Code", description: "最新编码 Agent · 256K 上下文" },
      { value: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code Highspeed", description: "高速编码 Agent" },
      { value: "kimi-k2.5", label: "Kimi K2.5", description: "多模态与通用任务" },
      { value: "kimi-k2-thinking", label: "Kimi K2 Thinking", description: "深度推理任务" },
    ],
  },
  {
    id: "doubao",
    name: "豆包",
    company: "火山方舟",
    description: "火山引擎方舟 API",
    provider: "doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    icon: doubaoIcon,
    modelOptions: [
      { value: "doubao-seed-2-0-pro-260215", label: "Doubao Seed 2.0 Pro", description: "推荐 · 旗舰 Agent 通用模型" },
      { value: "doubao-seed-2-0-mini-260428", label: "Doubao Seed 2.0 Mini", description: "新快照 · 多模态与推理" },
      { value: "doubao-seed-2-0-lite-260428", label: "Doubao Seed 2.0 Lite", description: "新快照 · 高频低成本任务" },
      { value: "doubao-seed-2-0-code-preview-260215", label: "Doubao Seed 2.0 Code Preview", description: "预览版 · 编码 Agent" },
      { value: "doubao-1-5-pro-256k-250115", label: "Doubao 1.5 Pro 256K", description: "长上下文通用模型" },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    company: "MiniMax",
    description: "Anthropic 兼容接口",
    provider: "minimax",
    baseUrl: "https://api.minimaxi.com/anthropic/v1",
    icon: minimaxIcon,
    modelOptions: [
      { value: "MiniMax-M3", label: "MiniMax M3", description: "推荐 · Agent 与长上下文" },
      { value: "MiniMax-M2.7", label: "MiniMax M2.7", description: "推理与工具调用" },
      { value: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", description: "高速推理版本" },
      { value: "MiniMax-M2.5", label: "MiniMax M2.5", description: "高性价比模型" },
      { value: "MiniMax-M2.5-highspeed", label: "MiniMax M2.5 Highspeed", description: "高速高性价比版本" },
      { value: "MiniMax-M2.1", label: "MiniMax M2.1", description: "稳定工具调用模型" },
    ],
  },
  {
    id: "zhipu",
    name: "GLM（智谱）",
    company: "智谱 AI",
    description: "智谱开放平台兼容接口",
    provider: "zai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    icon: zhipuIcon,
    modelOptions: [
      { value: "glm-5.2", label: "GLM-5.2", description: "推荐 · 通用与 Agent 任务" },
      { value: "glm-5.1", label: "GLM-5.1", description: "复杂推理与编码" },
      { value: "glm-5-turbo", label: "GLM-5 Turbo", description: "低延迟工具调用" },
      { value: "glm-5", label: "GLM-5", description: "稳定旗舰模型" },
      { value: "glm-5v-turbo", label: "GLM-5V Turbo", description: "多模态 Coding 与图表理解" },
      { value: "glm-4.7", label: "GLM-4.7", description: "稳定通用模型" },
      { value: "glm-4.7-flashx", label: "GLM-4.7 FlashX", description: "高速增强版本" },
      { value: "glm-4.7-flash", label: "GLM-4.7 Flash", description: "快速轻量任务" },
    ],
  },
  {
    id: "custom",
    name: "自定义",
    company: "兼容服务",
    description: "手动填写 Provider 与连接信息",
    provider: "openai-compatible",
    baseUrl: "",
    modelOptions: [],
  },
] as const;

export function findAiProviderTemplate(provider: string): AiProviderTemplate | null {
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider === "openai-codex-cli") {
    return AI_PROVIDER_TEMPLATES.find((template) => template.id === "openai") ?? null;
  }
  if (normalizedProvider === "claude-code") {
    return AI_PROVIDER_TEMPLATES.find((template) => template.id === "anthropic") ?? null;
  }
  return AI_PROVIDER_TEMPLATES.find((template) => template.id !== "custom" && template.provider === normalizedProvider) ?? null;
}

export function aiProviderUsesLocalCli(provider: string): boolean {
  return provider === "openai-codex-cli" || provider === "claude-code";
}

export function AiProviderGuide({
  template,
  local,
  status,
}: {
  template: AiProviderTemplate;
  local?: boolean;
  status?: AiLocalCliStatus | null;
}) {
  const { t } = useTranslation("settings");
  const localConnection = AI_LOCAL_CONNECTIONS[template.id];
  const guide = local && localConnection ? localConnection.guide : AI_PROVIDER_GUIDES[template.id];
  if (!guide) return null;
  const localName = localConnection?.provider === "claude-code" ? "Claude Code" : "Codex";
  const providerName = t(`aiProviderName_${template.id}`);
  return (
    <section className="ai-provider-guide" aria-label={t("aiProviderGuideAria", { provider: providerName })}>
      <div className="ai-provider-guide-icon" aria-hidden="true">{local ? <Laptop size={17} /> : <KeyRound size={17} />}</div>
      <div className="ai-provider-guide-copy">
        <div className="ai-provider-guide-title">
          <strong>{t(local ? "localLoginAccess" : "apiAccessGuide")}</strong>
          {local && status ? (
            <span className={clsx(status.authenticated ? "ready" : "unavailable")}>
              {status.authenticated ? <Check size={11} /> : <CircleAlert size={11} />}
              {t(status.authenticated ? "localCliSignedIn" : status.installed ? "localCliNotSignedIn" : "localCliNotInstalled", { name: status.name })}
            </span>
          ) : null}
        </div>
        <ol>
          <li>{t(local ? "localGuideStepInstall" : "apiGuideStepCreate", { provider: providerName, cli: localName })}</li>
          <li>{t(local ? "localGuideStepConnect" : "apiGuideStepVerify", { provider: providerName, cli: localName })}</li>
        </ol>
        <small>{t(local ? "localGuideSecurityNote" : "apiGuideBillingNote")}</small>
      </div>
      <a href={guide.url} target="_blank" rel="noreferrer">{t(local ? "openLocalAuthGuide" : "openProviderConsole", { provider: providerName, cli: localName })}<ExternalLink size={12} /></a>
    </section>
  );
}

export function createUniqueAiModelName(baseName: string, existingNames: readonly string[]): string {
  const normalized = new Set(existingNames.map((name) => name.trim().toLocaleLowerCase()).filter(Boolean));
  if (!normalized.has(baseName.toLocaleLowerCase())) return baseName;
  let suffix = 1;
  while (normalized.has(`${baseName}-${suffix}`.toLocaleLowerCase())) suffix += 1;
  return `${baseName}-${suffix}`;
}

export function AiModelIdControl({
  template,
  value,
  onChange,
  ariaLabel = "Model ID",
}: {
  template: AiProviderTemplate | null;
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
}) {
  const { t } = useTranslation("settings");
  const isRecommendedModel = Boolean(template?.modelOptions.some((option) => option.value === value));
  const [customMode, setCustomMode] = useState(() => !template || !isRecommendedModel);
  const options = useMemo(() => [
    ...(template?.modelOptions ?? []).map((option) => ({ ...option, description: t("providerModelOption") })),
    { value: CUSTOM_MODEL_VALUE, label: t("customModelId"), description: t("otherModelId") },
  ], [t, template]);

  if (!template || customMode) {
    return (
      <div className="ai-model-id-custom">
        <input
          aria-label={ariaLabel}
          value={value}
          placeholder={t("customModelIdPlaceholder")}
          onChange={(event) => onChange(event.target.value)}
        />
        {template ? (
          <button
            type="button"
            onClick={() => {
              setCustomMode(false);
              onChange(template.modelOptions[0]?.value ?? "");
            }}
          >
            {t("chooseRecommendedModel")}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <TerminalSelect
      ariaLabel={ariaLabel}
      value={value}
      placeholder={t("selectModel")}
      options={options}
      onChange={(next) => {
        if (next === CUSTOM_MODEL_VALUE) {
          setCustomMode(true);
          onChange("");
          return;
        }
        onChange(next);
      }}
      menuMinWidth={320}
    />
  );
}

export function AiProviderSetupFlow({
  existingNames,
  onAdd,
  onCancel,
}: {
  existingNames: readonly string[];
  onAdd: (value: AiProviderSetupValue) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [selectedId, setSelectedId] = useState<AiProviderTemplateId | null>(null);
  const selectedTemplate = AI_PROVIDER_TEMPLATES.find((template) => template.id === selectedId) ?? null;
  const [draft, setDraft] = useState<AiProviderSetupValue>({
    name: "",
    provider: "",
    model: "",
    baseUrl: "",
    apiKey: "",
  });
  const [validationMessage, setValidationMessage] = useState("");
  const [authMode, setAuthMode] = useState<"api-key" | "local-cli">("api-key");
  const [localStatuses, setLocalStatuses] = useState<AiLocalCliStatus[]>([]);
  const [checkingLocalAuth, setCheckingLocalAuth] = useState(false);

  const refreshLocalAuth = useCallback(async () => {
    setCheckingLocalAuth(true);
    try {
      const snapshot = await loadAiLocalAuthStatus();
      setLocalStatuses(snapshot?.providers ?? []);
    } finally {
      setCheckingLocalAuth(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId || !AI_LOCAL_CONNECTIONS[selectedId]) return;
    void refreshLocalAuth();
  }, [refreshLocalAuth, selectedId]);

  const selectTemplate = (template: AiProviderTemplate) => {
    const baseName = template.id === "custom" ? t("settings:customModelName") : t(`settings:aiProviderName_${template.id}`);
    setSelectedId(template.id);
    setAuthMode("api-key");
    setDraft({
      name: createUniqueAiModelName(baseName, existingNames),
      provider: template.provider,
      model: template.modelOptions[0]?.value ?? "",
      baseUrl: template.baseUrl,
      apiKey: "",
    });
    setValidationMessage("");
  };

  const updateDraft = (patch: Partial<AiProviderSetupValue>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setValidationMessage("");
  };

  const localConnection = selectedTemplate ? AI_LOCAL_CONNECTIONS[selectedTemplate.id] ?? null : null;
  const localStatus = localConnection
    ? localStatuses.find((status) => status.id === localConnection.provider) ?? null
    : null;

  const selectAuthMode = (nextMode: "api-key" | "local-cli") => {
    if (!selectedTemplate) return;
    if (nextMode === "local-cli") {
      if (!localConnection || !localStatus?.authenticated) return;
      setAuthMode(nextMode);
      updateDraft({
        provider: localConnection.provider,
        baseUrl: localConnection.baseUrl,
        apiKey: "",
      });
      return;
    }
    setAuthMode(nextMode);
    updateDraft({
      provider: selectedTemplate.provider,
      baseUrl: selectedTemplate.baseUrl,
      apiKey: "",
    });
  };

  const submit = () => {
    if (!draft.name.trim() || !draft.provider.trim() || !draft.model.trim() || !draft.baseUrl.trim()) {
      setValidationMessage(t("settings:completeAiConnectionFields"));
      return;
    }
    onAdd({
      name: draft.name.trim(),
      provider: draft.provider.trim(),
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
    });
  };

  if (!selectedTemplate) {
    return (
      <div className="ai-provider-setup ai-provider-choice-step">
        <div className="ai-provider-choice-head">
          <div>
            <span>{t("settings:chooseConnectionMethod")}</span>
            <strong>{t("settings:providerTemplateHeadline")}</strong>
          </div>
          <small>{t("settings:providerTemplateAdjustHelp")}</small>
        </div>
        <div className="ai-provider-grid" role="list" aria-label={t("settings:aiProviders")}>
          {AI_PROVIDER_TEMPLATES.map((template) => {
            const providerName = t(`settings:aiProviderName_${template.id}`);
            const providerCompany = t(`settings:aiProviderCompany_${template.id}`);
            return (
              <button
                type="button"
                className={clsx("ai-provider-option", template.id === "custom" && "custom")}
                onClick={() => selectTemplate(template)}
                role="listitem"
                data-provider-template={template.id}
                key={template.id}
              >
                <span className="ai-provider-option-icon" aria-hidden="true">
                  {template.icon ? <img src={template.icon} alt="" /> : <SlidersHorizontal size={22} />}
                </span>
                <span className="ai-provider-option-copy">
                  <strong>{providerName}</strong>
                  <small>{providerCompany}</small>
                  <em>{t(`settings:aiProviderDescription_${template.id}`)}</em>
                </span>
              </button>
            );
          })}
        </div>
        <div className="ai-provider-setup-footer">
          <span><KeyRound size={13} />{t("settings:apiKeyStoredLocally")}</span>
          <button type="button" onClick={onCancel}>{t("common:cancel")}</button>
        </div>
      </div>
    );
  }

  const isCustom = selectedTemplate.id === "custom";
  return (
    <div className="ai-provider-setup ai-provider-form-step">
      <div className="ai-provider-selected-head">
        <button type="button" className="ai-provider-back" onClick={() => setSelectedId(null)} title={t("settings:returnToProviderList")} aria-label={t("settings:returnToProviderList")}>
          <ArrowLeft size={16} />
        </button>
        <span className="ai-provider-option-icon" aria-hidden="true">
          {selectedTemplate.icon ? <img src={selectedTemplate.icon} alt="" /> : <ServerCog size={22} />}
        </span>
        <div>
          <span>{isCustom ? t("settings:customConnection") : t("settings:providerTemplateName", { company: t(`settings:aiProviderCompany_${selectedTemplate.id}`) })}</span>
          <strong>{t(`settings:aiProviderName_${selectedTemplate.id}`)}</strong>
          <small>{t(`settings:aiProviderDescription_${selectedTemplate.id}`)}</small>
        </div>
        {!isCustom ? <em><Check size={12} />{t("settings:clineBuiltinProvider")}</em> : null}
      </div>

      <div className="ai-provider-form-grid">
        {!isCustom && localConnection ? (
          <div className="ai-provider-auth-block wide">
            <div className="ai-provider-auth-mode" role="group" aria-label={t("settings:connectionMethod")}>
              <button type="button" className={clsx(authMode === "api-key" && "active")} onClick={() => selectAuthMode("api-key")}>
                <KeyRound size={14} /><span>API Key</span><small>{t("settings:providerPlatform")}</small>
              </button>
              <button
                type="button"
                className={clsx(authMode === "local-cli" && "active")}
                disabled={!localStatus?.authenticated}
                onClick={() => selectAuthMode("local-cli")}
              >
                <Laptop size={14} /><span>{localConnection.provider === "claude-code" ? "Claude Code" : "Codex"}</span><small>{localStatus?.authenticated ? localStatus.authMethod || t("settings:signedIn") : localStatus?.installed ? t("settings:signInRequired") : t("settings:notDetected")}</small>
              </button>
              <button type="button" className="refresh" onClick={() => void refreshLocalAuth()} disabled={checkingLocalAuth} title={t("settings:rescanLocalLogin")}>
                <RefreshCw size={13} className={clsx(checkingLocalAuth && "spinning")} />
              </button>
            </div>
            {!localStatus?.authenticated ? (
              <div className="ai-provider-login-hint">
                <CircleAlert size={12} />
                <span>{localStatus?.installed ? t("settings:completeOfficialLogin") : t("settings:installAndLoginCli", { name: localConnection.provider === "claude-code" ? "Claude Code" : "Codex" })}</span>
                <code>{localConnection.loginCommand}</code>
                <button type="button" title={t("settings:copyLoginCommand")} aria-label={t("settings:copyLoginCommand")} onClick={() => void navigator.clipboard?.writeText(localConnection.loginCommand)}><Copy size={12} /></button>
              </div>
            ) : null}
          </div>
        ) : null}

        {!isCustom ? <AiProviderGuide template={selectedTemplate} local={authMode === "local-cli"} status={localStatus} /> : null}

        <label>
          <span>{t("settings:configurationName")}</span>
          <input autoFocus value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} />
          <small>{t("settings:configurationNameHelp")}</small>
        </label>
        <label>
          <span>Provider</span>
          <input value={draft.provider} readOnly={!isCustom} onChange={(event) => updateDraft({ provider: event.target.value })} />
          <small>{t(isCustom ? "settings:customProviderHelp" : "settings:templateProviderHelp")}</small>
        </label>
        <label className="wide ai-provider-model-field">
          <span>Model ID</span>
          <AiModelIdControl
            key={selectedTemplate.id}
            template={isCustom ? null : selectedTemplate}
            value={draft.model}
            onChange={(model) => updateDraft({ model })}
          />
          <small>{t("settings:modelSelectionHelp")}</small>
        </label>
        <label className="wide">
          <span>Base URL</span>
          <input value={draft.baseUrl} readOnly={authMode === "local-cli"} placeholder="https://api.example.com/v1" onChange={(event) => updateDraft({ baseUrl: event.target.value })} />
          <small>{t(authMode === "local-cli" ? "settings:localBaseUrlHelp" : isCustom ? "settings:compatibleBaseUrlHelp" : "settings:officialEndpointHelp")}</small>
        </label>
        {authMode === "api-key" ? <label className="wide">
          <span>API Key</span>
          <input type="password" autoComplete="off" value={draft.apiKey} placeholder={t("settings:providerApiKeyPlaceholder")} onChange={(event) => updateDraft({ apiKey: event.target.value })} />
          <small>{t("settings:providerApiKeySecurity")}</small>
        </label> : (
          <div className="ai-provider-local-auth wide">
            <Check size={16} />
            <div><strong>{t("settings:localCliConnected", { name: localStatus?.name })}</strong><span>{localStatus?.version ?? t("settings:officialCliDetected")} · {localStatus?.authMethod ?? t("settings:localLogin")}</span></div>
            <code>{localConnection?.loginCommand}</code>
          </div>
        )}
      </div>

      <div className="ai-provider-setup-footer form-footer">
        <span className={clsx(validationMessage && "invalid")}>{validationMessage || t("settings:addConfigurationNextStep")}</span>
        <div>
          <button type="button" onClick={onCancel}>{t("common:cancel")}</button>
          <button type="button" className="primary-action" onClick={submit}>{t("settings:addToConfigurationList")}</button>
        </div>
      </div>
    </div>
  );
}
