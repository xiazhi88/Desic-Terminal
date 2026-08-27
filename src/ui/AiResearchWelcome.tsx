import { BarChart3, BookOpen, Gauge, Radar, Waves } from "lucide-react";
import type { ReactNode } from "react";

type WelcomeAction = {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  prompt: string;
};

export function AiResearchWelcome({ symbol, accountLabel, onSelect, uiText }: { symbol?: string; accountLabel?: string; onSelect: (prompt: string) => void; uiText: (zh: string, en: string) => string }) {
  const target = symbol || uiText("当前选中永续合约", "the selected perpetual");
  const actions: WelcomeAction[] = [
    { id: "market", label: uiText("市场快照", "Market snapshot"), description: uiText("价格、盘口压力与近期流动", "Price, book pressure and recent flow"), icon: <Gauge size={16} />, prompt: uiText(`读取 ${target} 的当前市场快照，包括价格、点差、盘口压力与数据新鲜度。`, `Read the current market snapshot for ${target}, including price, spread, order book pressure and freshness.`) },
    { id: "structure", label: uiText("K 线结构", "Candle structure"), description: uiText("趋势、关键价位和失效条件", "Trend, levels and invalidation"), icon: <BarChart3 size={16} />, prompt: uiText(`分析 ${target} 的多周期 K 线结构，包括趋势、关键价位、波动与失效条件。`, `Analyze the multi-timeframe candle structure for ${target}, with trend, key levels, volatility and invalidation conditions.`) },
    { id: "flow", label: uiText("资金费率与流动", "Funding and flow"), description: uiText("资金费率、未平仓量和拥挤度", "Funding, open interest and crowding"), icon: <Waves size={16} />, prompt: uiText(`审查 ${target} 的资金费率、未平仓量与拥挤度，区分观察数据和解释。`, `Review funding, open interest and crowding for ${target}. Separate observed data from interpretation.`) },
    ...(accountLabel ? [{ id: "risk", label: uiText("账户风险", "Account risk"), description: uiText(`${accountLabel} 的只读审查`, `Read-only review for ${accountLabel}`), icon: <BookOpen size={16} />, prompt: uiText("审查已绑定账户的风险、仓位、保证金和订单保护状态，仅作只读分析。", "Review the bound account risk context, positions, margin and order protection. Keep the review read-only.") }] : []),
    { id: "radar", label: "Market Radar", description: uiText("发现全市场值得关注的永续合约", "Find notable perpetuals across the market"), icon: <Radar size={16} />, prompt: uiText("执行受限的 Market Radar 研究扫描，并说明排名证据、覆盖范围和新鲜度。", "Run a bounded Market Radar research scan and explain the ranking evidence, coverage and freshness.") }
  ];
  return (
    <section className="ai-research-welcome" aria-labelledby="ai-research-welcome-title">
      <div className="ai-research-welcome-kicker">AI RESEARCH / PERPETUALS</div>
      <h1 id="ai-research-welcome-title">{uiText("从一个市场问题开始。", "Start with a market question.")}</h1>
      <p>{uiText("选择一个研究起点，再在发送前补充问题。分析仍遵循当前权限与审批策略。", "Use a focused research starter, then refine the question before sending. Analysis stays subject to the active permission and approval policy.")}</p>
      <div className="ai-research-welcome-actions">
        {actions.map((action) => (
          <button type="button" key={action.id} onClick={() => onSelect(action.prompt)}>
            <span className="ai-research-welcome-icon">{action.icon}</span>
            <span><strong>{action.label}</strong><small>{action.description}</small></span>
          </button>
        ))}
      </div>
    </section>
  );
}
