import type { ComponentType } from "react";
import { BarChart3, Bot, CandlestickChart, CircleHelp, FlaskConical, LineChart, Search, Settings2, ShieldCheck, WalletCards, type LucideProps } from "lucide-react";
import type { AiToolPresentation } from "./aiToolPresentation";
import skillAsset from "../assets/ai-tools/skill.svg";
import marketAsset from "../assets/ai-tools/market.svg";
import intelligenceAsset from "../assets/ai-tools/intelligence.svg";
import accountAsset from "../assets/ai-tools/account.svg";
import tradeAsset from "../assets/ai-tools/trade.svg";
import researchAsset from "../assets/ai-tools/research.svg";
import strategyAsset from "../assets/ai-tools/strategy.svg";
import agentAsset from "../assets/ai-tools/agent.svg";
import systemAsset from "../assets/ai-tools/system.svg";

const ASSETS: Partial<Record<AiToolPresentation["domain"], string>> = {
  skill: skillAsset,
  market: marketAsset,
  intelligence: intelligenceAsset,
  account: accountAsset,
  trade: tradeAsset,
  research: researchAsset,
  strategy: strategyAsset,
  agent: agentAsset,
  system: systemAsset
};

const ICONS: Record<AiToolPresentation["domain"], ComponentType<LucideProps>> = {
  skill: SparkleFallback,
  market: CandlestickChart,
  intelligence: Search,
  account: WalletCards,
  strategy: FlaskConical,
  chart: LineChart,
  trade: ShieldCheck,
  research: Search,
  system: Settings2,
  agent: Bot
};

function SparkleFallback(props: LucideProps) {
  return <BarChart3 {...props} />;
}

export function AiToolDomainIcon({ domain, size = 14, ...props }: { domain: AiToolPresentation["domain"] } & LucideProps) {
  const asset = ASSETS[domain];
  if (asset) return <img className="ai-tool-domain-icon" src={asset} width={size} height={size} alt="" aria-hidden="true" />;
  const Icon = ICONS[domain] ?? CircleHelp;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" {...props} />;
}

export function AiToolDomainIconByName({ domain, size = 14, ...props }: { domain?: AiToolPresentation["domain"] } & LucideProps) {
  return <AiToolDomainIcon domain={domain ?? "system"} size={size} {...props} />;
}
