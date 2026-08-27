import type { AiSkillDefinition } from "../types";

export type AiResearchCommand = {
  id: string;
  label: string;
  description: string;
  aliases: string[];
  prompt: (symbol?: string) => string;
};

export const AI_RESEARCH_COMMANDS: readonly AiResearchCommand[] = [
  { id: "market", label: "Market snapshot", description: "Price, order book, trades and freshness", aliases: ["snapshot", "price", "book"], prompt: (symbol) => `Read a current perpetual market snapshot for ${symbol || "the selected contract"}: price, order book pressure, recent trades, spread, and data freshness. Keep the result evidence-based.` },
  { id: "structure", label: "Candle structure", description: "Multi-timeframe trend and technical structure", aliases: ["candles", "technical", "trend"], prompt: (symbol) => `Analyze the multi-timeframe candle structure for ${symbol || "the selected perpetual"}, including trend, support/resistance, volatility, and invalidation conditions. Cite the observed evidence.` },
  { id: "flow", label: "Funding and flow", description: "Funding, open interest and crowding", aliases: ["funding", "oi", "open-interest", "crowding"], prompt: (symbol) => `Review funding, open interest, positioning and crowding for ${symbol || "the selected perpetual"}. Separate observed data from interpretation and identify meaningful changes.` },
  { id: "radar", label: "Market Radar", description: "Cross-market discovery and ranking", aliases: ["breadth", "scan", "leaders"], prompt: () => "Run a bounded Market Radar research scan across live perpetuals. Explain the ranking evidence, coverage, freshness and notable risks; do not treat the ranking as a trade command." },
  { id: "intelligence", label: "Market intelligence", description: "News, macro and smart-money evidence", aliases: ["news", "macro", "smart-money"], prompt: (symbol) => `Gather attributable market intelligence relevant to ${symbol || "the selected perpetual"}: news, macro context and smart-money evidence. Separate source facts, timestamps and uncertainty.` },
  { id: "risk", label: "Account risk", description: "Read-only account, margin and position review", aliases: ["account", "margin", "positions"], prompt: () => "Read the bound account risk context and review margin, positions, orders and protection status. Keep this read-only and identify missing account context explicitly." },
  { id: "compare", label: "Compare contracts", description: "Compare selected perpetuals across research dimensions", aliases: ["comparison", "relative"], prompt: (symbol) => `Compare ${symbol || "the selected perpetual"} with one or more relevant perpetual contracts across price structure, flow, liquidity and intelligence. Ask for a second contract if needed.` },
  { id: "review", label: "Trade-plan review", description: "Review a plan without executing it", aliases: ["plan", "postmortem", "recap"], prompt: () => "Review the trade plan or recap in this conversation. Identify thesis, evidence, invalidation, sizing and execution risks. Do not place or modify orders." }
];

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
