export type AiToolPresentation = {
  canonicalName: string;
  label: string;
  summary: string;
  domain: "skill" | "market" | "intelligence" | "account" | "strategy" | "chart" | "trade" | "research" | "system" | "agent";
  icon: string;
};

const DOMAIN_LABELS: Record<AiToolPresentation["domain"], [string, string]> = {
  skill: ["Skill", "Skill"],
  market: ["Market", "市场"],
  intelligence: ["Intelligence", "情报"],
  account: ["Account", "账户"],
  strategy: ["Strategy", "策略"],
  chart: ["Chart", "图表"],
  trade: ["Trading", "交易"],
  research: ["Research", "研究"],
  system: ["System", "系统"],
  agent: ["Agent", "代理"]
};

const PRESENTATIONS: Record<string, Omit<AiToolPresentation, "canonicalName">> = {
  "market.readDecisionContext": { label: "Decision context", summary: "Read the live market and account decision snapshot.", domain: "market", icon: "market" },
  "market.readTicker": { label: "Market ticker", summary: "Read current price and activity data.", domain: "market", icon: "market" },
  "market.readCandles": { label: "Price history", summary: "Read historical candles for analysis.", domain: "market", icon: "market" },
  "account.readSnapshot": { label: "Account snapshot", summary: "Read balances, positions, and open orders.", domain: "account", icon: "account" },
  "strategy.create": { label: "Create strategy", summary: "Create a strategy research workspace.", domain: "strategy", icon: "strategy" },
  "strategy.backtest": { label: "Run backtest", summary: "Evaluate a pinned strategy version on historical data.", domain: "strategy", icon: "strategy" },
  "strategy.optimize": { label: "Tune strategy", summary: "Search the configured parameter ranges.", domain: "strategy", icon: "strategy" },
  "chart.createIndicator": { label: "Add indicator", summary: "Create a chart indicator from the safe DSL.", domain: "chart", icon: "chart" },
  "trade.precheck": { label: "Trade precheck", summary: "Validate a proposed trade against current constraints.", domain: "trade", icon: "trade" },
  "trade.submit": { label: "Submit order", summary: "Submit an authorized order request.", domain: "trade", icon: "trade" },
  "radar.readRanking": { label: "Read market ranking", summary: "Read persisted cross-market research evidence.", domain: "research", icon: "research" },
  "research.webSearch": { label: "Web research", summary: "Read attributable external market intelligence.", domain: "intelligence", icon: "intelligence" }
};

function humanizeToolName(name: string) {
  const leaf = name.split(/[.:/]/).at(-1) || name;
  return leaf.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/^./, (value) => value.toUpperCase());
}

function inferDomain(name: string): AiToolPresentation["domain"] {
  const prefix = name.split(/[.:/]/)[0]?.toLowerCase();
  if (prefix === "market" || prefix === "okx") return "market";
  if (prefix === "skill" || prefix === "skills") return "skill";
  if (prefix === "account" || prefix === "position") return "account";
  if (prefix === "strategy" || prefix === "profile") return "strategy";
  if (prefix === "chart" || prefix === "indicator") return "chart";
  if (prefix === "trade" || prefix === "order") return "trade";
  if (prefix === "intelligence") return "intelligence";
  if (prefix === "radar" || prefix === "research") return "research";
  if (prefix === "agent" || prefix === "subagent") return "agent";
  return "system";
}

export function canonicalAiToolName(name: string) {
  const trimmed = name.trim();
  return PRESENTATIONS[trimmed] ? trimmed : trimmed.replace(/^mcp__[^_]+__/, "");
}

export function getAiToolPresentation(name: string): AiToolPresentation {
  const canonicalName = canonicalAiToolName(name);
  const known = PRESENTATIONS[canonicalName];
  if (known) return { canonicalName, ...known };
  const domain = inferDomain(canonicalName);
  const [domainEn, domainZh] = DOMAIN_LABELS[domain];
  const label = humanizeToolName(canonicalName);
  return {
    canonicalName,
    label,
    summary: `${domainEn} tool: ${label}.`,
    domain,
    icon: domain
  };
}

export function getAiToolDomainLabel(domain: AiToolPresentation["domain"], language = "en-US") {
  const pair = DOMAIN_LABELS[domain];
  return language.toLowerCase().startsWith("zh") ? pair[1] : pair[0];
}
