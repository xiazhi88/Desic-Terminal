import type { AiSkillDefinition } from "../types";

export type AiResearchCommandParam = {
  name: string;
  description: string;
};

export type AiResearchCommand = {
  id: string;
  label: string;
  description: string;
  aliases: string[];
  prompt: (symbol?: string) => string;
  params?: AiResearchCommandParam[];
};

// 参数化命令的模板用 {{paramName}} 占位：面板选中插入时占位符原样可见，
// composer 提交路径（expandAiSlashInput）按顺序把 /命令 arg1 arg2 的 args 回填进占位符。
const AI_SYMBOL_PARAM: AiResearchCommandParam = { name: "symbol", description: "perpetual contract symbol" };
const AI_TIMEFRAME_PARAM: AiResearchCommandParam = { name: "timeframe", description: "candle timeframe such as 4h or 1d" };

export const AI_RESEARCH_COMMANDS: readonly AiResearchCommand[] = [
  { id: "market", label: "Market snapshot", description: "Price, order book, trades and freshness", aliases: ["snapshot", "price", "book"], params: [AI_SYMBOL_PARAM], prompt: () => `Read a current perpetual market snapshot for {{symbol}}: price, order book pressure, recent trades, spread, and data freshness. Keep the result evidence-based.` },
  { id: "structure", label: "Candle structure", description: "Multi-timeframe trend and technical structure", aliases: ["candles", "technical", "trend"], params: [AI_SYMBOL_PARAM, AI_TIMEFRAME_PARAM], prompt: () => `Analyze the multi-timeframe candle structure for {{symbol}}, anchored on the {{timeframe}} timeframe, including trend, support/resistance, volatility, and invalidation conditions. Cite the observed evidence.` },
  { id: "flow", label: "Funding and flow", description: "Funding, open interest and crowding", aliases: ["funding", "oi", "open-interest", "crowding"], params: [AI_SYMBOL_PARAM], prompt: () => `Review funding, open interest, positioning and crowding for {{symbol}}. Separate observed data from interpretation and identify meaningful changes.` },
  { id: "radar", label: "Market Radar", description: "Cross-market discovery and ranking", aliases: ["breadth", "scan", "leaders"], prompt: () => "Run a bounded Market Radar research scan across live perpetuals. Explain the ranking evidence, coverage, freshness and notable risks; do not treat the ranking as a trade command." },
  { id: "intelligence", label: "Market intelligence", description: "News, macro and smart-money evidence", aliases: ["news", "macro", "smart-money"], prompt: (symbol) => `Gather attributable market intelligence relevant to ${symbol || "the selected perpetual"}: news, macro context and smart-money evidence. Separate source facts, timestamps and uncertainty.` },
  { id: "risk", label: "Account risk", description: "Read-only account, margin and position review", aliases: ["account", "margin", "positions"], prompt: () => "Read the bound account risk context and review margin, positions, orders and protection status. Keep this read-only and identify missing account context explicitly." },
  { id: "compare", label: "Compare contracts", description: "Compare selected perpetuals across research dimensions", aliases: ["comparison", "relative"], params: [AI_SYMBOL_PARAM], prompt: () => `Compare {{symbol}} with one or more relevant perpetual contracts across price structure, flow, liquidity and intelligence. Ask for a second contract if needed.` },
  { id: "review", label: "Trade-plan review", description: "Review a plan without executing it", aliases: ["plan", "postmortem", "recap"], prompt: () => "Review the trade plan or recap in this conversation. Identify thesis, evidence, invalidation, sizing and execution risks. Do not place or modify orders." }
];

// 按命令名（id 或 alias，精确匹配、大小写不敏感）解析 slash 首个 token；未匹配返回 null。
export function matchAiResearchCommand(token: string): AiResearchCommand | null {
  const needle = token.replace(/^\/+/, "").trim().toLowerCase();
  if (!needle) return null;
  return AI_RESEARCH_COMMANDS.find((command) => command.id === needle || command.aliases.includes(needle)) ?? null;
}

// 按顺序把 args 填入模板占位符：多余 args 忽略，缺失的保留 {{param}} 原样可见。
export function expandAiCommandPrompt(command: AiResearchCommand, args: readonly string[]): string {
  const params = command.params ?? [];
  return params.reduce((template, param, index) => {
    const value = args[index]?.trim();
    return value ? template.replaceAll(`{{${param.name}}}`, value) : template;
  }, command.prompt());
}

// 解析 "/命令名 arg1 arg2" 输入：首个 token 命中参数化命令时返回展开后的模板，否则返回 null。
export function expandAiSlashInput(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const segments = input.slice(1).split(/\s+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const command = matchAiResearchCommand(segments[0]);
  if (!command || !command.params?.length) return null;
  return expandAiCommandPrompt(command, segments.slice(1));
}

export type AiSlashEntry =
  | { kind: "command"; value: AiResearchCommand }
  | { kind: "skill"; value: AiSkillDefinition };

export function filterAiSlashEntries(commands: readonly AiResearchCommand[], skills: readonly AiSkillDefinition[], query: string): AiSlashEntry[] {
  const needle = query.trim().toLowerCase();
  const commandEntries = commands
    .filter((item) => `${item.id} ${item.label} ${item.description} ${item.aliases.join(" ")}`.toLowerCase().includes(needle))
    .map((value) => ({ kind: "command" as const, value }));
  const skillEntries = skills
    .filter((item) => `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(needle))
    .map((value) => ({ kind: "skill" as const, value }));
  return [...commandEntries, ...skillEntries];
}
