import type { AiSession, MarketAssetsSummary, Ticker } from "../../types";
import { storedMessageToUiMessage, type AiUiMessage } from "../AiMessageProcess";

// Preview fixtures for the AI research workspace, extracted verbatim from App.tsx.

export const previewLegacyToolMessage = storedMessageToUiMessage({
  id: "preview-history-tools",
  sessionId: "preview-history",
  role: "assistant",
  content: "",
  status: "completed",
  toolJson: JSON.stringify([
    {
      type: "processReasoningSummary",
      id: "preview-reasoning-summary-1",
      content: "**Inspecting account and market context**"
    },
    {
      type: "processReasoningSummary",
      id: "preview-reasoning-summary-2",
      content: "**Planning the risk review**"
    },
    {
      type: "processReasoning",
      content: "先读取账户和市场上下文，再核对风险限制，最后给出只读结论。"
    },
    {
      type: "toolCall",
      toolCallId: "provider-instrument-call",
      name: "market.readInstrument",
      arguments: { instId: "BTC-USDT-SWAP" },
      allowed: true,
      startedAt: 1_784_810_000_000
    },
    {
      type: "toolCall",
      toolCallId: "internal-instrument-execution",
      name: "market.readInstrument",
      arguments: { instId: "BTC-USDT-SWAP" },
      allowed: true,
      policy: "rust:tool-execute-request",
      agentId: "preview-agent"
    },
    {
      type: "toolResult",
      toolCallId: "internal-instrument-execution",
      name: "market.readInstrument",
      result: { instId: "BTC-USDT-SWAP" },
      summary: "合约规格已读取",
      ok: true
    },
    {
      type: "toolResult",
      toolCallId: "provider-instrument-call",
      name: "market.readInstrument",
      result: { instId: "BTC-USDT-SWAP" },
      summary: "合约规格已读取",
      ok: true,
      endedAt: 1_784_810_002_400
    },
    {
      type: "agentStart",
      agentId: "preview-history-market",
      configuredAgentId: "preview-history-market",
      title: "历史市场结构",
      task: "验证稳定 Agent 身份与完成状态。",
      startedAt: 1_784_810_003_000
    },
    {
      type: "agentStart",
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      title: "历史市场结构",
      task: "验证稳定 Agent 身份与完成状态。",
      startedAt: 1_784_810_003_100
    },
    {
      type: "toolCall",
      toolCallId: "preview-history-ticker",
      name: "market.readTicker",
      arguments: { instId: "BTC-USDT-SWAP" },
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      startedAt: 1_784_810_004_000
    },
    {
      type: "toolResult",
      toolCallId: "preview-history-ticker",
      name: "market.readTicker",
      result: { last: "65088.1" },
      summary: "最新行情已返回",
      ok: true,
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      endedAt: 1_784_810_004_015
    },
    {
      type: "toolCall",
      toolCallId: "preview-history-crowding",
      name: "intelligence.smartMoney.readCrowdingComparison",
      arguments: { instId: "BTC-USDT-SWAP" },
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      startedAt: 1_784_810_005_000
    },
    {
      type: "toolResult",
      toolCallId: "preview-history-crowding",
      name: "intelligence.smartMoney.readCrowdingComparison",
      result: { accountRatio: 1.08 },
      summary: "拥挤度对比已返回",
      ok: true,
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      endedAt: 1_784_810_005_021
    },
    {
      type: "agentDone",
      agentId: "preview-history-market",
      configuredAgentId: "preview-history-market",
      status: "done",
      result: { finishReason: "completed" },
      endedAt: 1_784_810_008_000
    },
    {
      type: "processText",
      content: "历史工具状态已合并。"
    }
  ]),
  createdAt: 1
});

export const previewModelErrorMessage = storedMessageToUiMessage({
  id: "preview-model-error",
  sessionId: "preview-history",
  role: "assistant",
  content: "",
  status: "failed",
  toolJson: JSON.stringify([
    {
      type: "agentStart",
      agentId: "preview-model-error-agent",
      configuredAgentId: "preview-model-error-agent",
      title: "账户风险",
      task: "读取账户风险并给出结构化报告。",
      startedAt: 1_784_810_010_000
    },
    {
      type: "agentDone",
      agentId: "preview-model-error-agent",
      configuredAgentId: "preview-model-error-agent",
      status: "done",
      result: {
        finishReason: "error",
        iterations: 1,
        successfulTools: [],
        text: "Insufficient Balance",
        usage: { inputTokens: 0, outputTokens: 0 }
      },
      endedAt: 1_784_810_010_625
    }
  ]),
  createdAt: 2
});

// 证据账本回合：走 storedMessageToUiMessage（落库回放路径），覆盖 evidenceRef 编号、
// consult_experts 并行 / 串行、follow_up、账本修订与决策唤醒条件。
const ledgerBase = Date.now() - 18 * 60_000;
const ledgerCandles = (() => {
  const rows: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number; confirm: boolean }> = [];
  let price = 66_928;
  for (let index = 0; index < 60; index += 1) {
    const target = index < 44 ? 66_928 - (index / 43) * 4_228 : 62_700 + ((index - 43) / 16) * 1_569;
    const open = price;
    const close = target + Math.sin(index * 1.7) * 180;
    rows.push({
      time: ledgerBase - (60 - index) * 4 * 3_600_000,
      open,
      high: Math.max(open, close) + 90 + (index % 5) * 30,
      low: Math.min(open, close) - 80 - (index % 4) * 35,
      close,
      volume: 900 + (index % 7) * 140,
      confirm: true
    });
    price = close;
  }
  return rows;
})();
const ledgerTrades = Array.from({ length: 50 }, (_, index) => ({
  tradeId: `lt-${index}`,
  px: String(64_269 - index * 0.4),
  sz: String(0.02 + ((index * 37) % 11) / 10),
  side: index % 6 === 0 || index === 13 || index === 27 ? "buy" : "sell",
  ts: ledgerBase + 60_000 - index * 900
}));
const ledgerEvents: unknown[] = [];
const ledgerTool = (id: string, name: string, args: unknown, result: unknown, summary: string, at: number, agent?: string) => {
  const scope = agent ? { agentId: agent, configuredAgentId: agent } : {};
  ledgerEvents.push({ type: "toolCall", toolCallId: id, name, arguments: args, allowed: true, startedAt: at, ...scope });
  ledgerEvents.push({ type: "toolResult", toolCallId: id, name, result, summary, ok: true, startedAt: at, endedAt: at + 1_400, ...scope });
};
const ledgerAgent = (id: string, title: string, start: number, end: number, tokens: number) => {
  ledgerEvents.push({ type: "agentStart", agentId: id, configuredAgentId: id, title, role: "expert", task: `${title}：为 BTC 开仓判断提供只读证据。`, startedAt: start });
  ledgerEvents.push({ type: "agentDone", agentId: id, configuredAgentId: id, status: "done", result: { finishReason: "completed", iterations: 3, successfulTools: [], text: `${title}报告已返回。`, usage: { inputTokens: Math.round(tokens * 0.92), outputTokens: Math.round(tokens * 0.08) } }, endedAt: end });
};
ledgerTool("lc-candles", "market.readCandles", { instId: "BTC-USDT-SWAP", bar: "4H", limit: 60 }, { instId: "BTC-USDT-SWAP", bar: "4H", candles: ledgerCandles, evidenceRef: "E1" }, "BTC-USDT-SWAP 4H 最近 60 根 K 线", ledgerBase);
ledgerTool("lc-book", "market.readOrderBook", { instId: "BTC-USDT-SWAP", depth: 400 }, {
  instId: "BTC-USDT-SWAP",
  bids: Array.from({ length: 40 }, (_, index) => [String(64_268.9 - index * 0.5), String(0.4 + ((index * 13) % 9) / 3)]),
  asks: Array.from({ length: 40 }, (_, index) => [String(64_269.1 + index * 0.5), String(0.42 + ((index * 7) % 9) / 3)]),
  evidenceRef: "E2"
}, "±0.5% 盘口买卖接近对称", ledgerBase + 2_000);
ledgerTool("lc-trades", "market.readTrades", { instId: "BTC-USDT-SWAP", limit: 50 }, { instId: "BTC-USDT-SWAP", trades: ledgerTrades, evidenceRef: "E3" }, "最近 50 笔成交中 41 笔主动卖", ledgerBase + 4_000);
ledgerTool("lc-consult", "consult_experts", { experts: [{ expertId: "market-structure" }, { expertId: "flow-intel" }], mode: "parallel" }, {
  ok: true,
  results: [
    { expertId: "market-structure", expertName: "市场结构", mode: "parallel", report: "价格高于 15m VWAP；雷达综合评分 82，排名 #3。" },
    { expertId: "flow-intel", expertName: "情报资金", mode: "parallel", report: "头部持仓价值偏空 topPositionRatio≈0.97；散户多空比 1.58；近 4H 吃单净流入约 2,800 万 USD。" }
  ],
  failures: [],
  evidenceRef: "E4"
}, "2 位专家并行返回", ledgerBase + 6_000);
ledgerAgent("market-structure", "市场结构", ledgerBase + 6_200, ledgerBase + 13_600, 8_600);
ledgerAgent("flow-intel", "情报资金", ledgerBase + 6_300, ledgerBase + 16_900, 10_300);
ledgerTool("lc-follow", "follow_up", { expertId: "flow-intel", question: "散户多空比是否与资金费率同向？" }, { ok: true, expertId: "flow-intel", expertName: "情报资金", report: "同向：资金费率 +0.008%，反向信号成立。", evidenceRef: "E5" }, "情报资金追问已返回", ledgerBase + 17_500);
ledgerTool("lc-risk", "consult_expert", { expertId: "account-risk" }, { ok: true, expertId: "account-risk", expertName: "账户风险", report: "无 BTC 持仓，可用 12.51 USDT。", evidenceRef: "E6" }, "账户风险已返回", ledgerBase + 21_000);
ledgerAgent("account-risk", "账户风险", ledgerBase + 21_100, ledgerBase + 23_500, 2_400);
ledgerTool("lc-news", "intelligence.news.list", { instId: "BTC-USDT-SWAP", hours: 6 }, { items: [{ title: "BTC 新闻情绪中性" }], evidenceRef: "E7" }, "BTC 6H 新闻情绪中性", ledgerBase + 24_000);
ledgerTool("lc-ledger-1", "research.recordEvidence", {}, {
  ledgerId: "ledger-preview-1",
  instId: "BTC-USDT-SWAP",
  displayOnly: true,
  recordedAt: ledgerBase + 26_000,
  items: [
    { id: "b1", claim: "4H 趋势 66,928 → 62,700，仍处下降通道", stance: "bear", weight: 3, sourceRefs: ["E1"] },
    { id: "b2", claim: "最近 50 笔成交中 41 笔为主动卖", stance: "bear", weight: 1.5, sourceRefs: ["E3"] },
    { id: "b3", claim: "头部交易者持仓价值偏空，topPositionRatio ≈ 0.97", stance: "bear", weight: 2, sourceRefs: ["E4"] },
    { id: "b4", claim: "散户多空比 1.58，显著偏多（反向信号）", stance: "bear", weight: 1.5, sourceRefs: ["E4", "E5"] },
    { id: "u1", claim: "自 62,700 低点反弹至 64,269（+2.5%）", stance: "bull", weight: 2.5, sourceRefs: ["E1"] },
    { id: "u2", claim: "价格高于 15m VWAP，短期动能向上", stance: "bull", weight: 1.5, sourceRefs: ["E4"] },
    { id: "u3", claim: "雷达综合评分 82，排名 #3（1 日 ↑1）", stance: "bull", weight: 1, sourceRefs: ["E4"] },
    { id: "u4", claim: "最近 4H 吃单净流入约 2,800 万 USD", stance: "bull", weight: 2, sourceRefs: ["E4"] },
    { id: "n1", claim: "±0.5% 盘口买卖接近对称", stance: "neutral", weight: 0, sourceRefs: ["E2"] },
    { id: "n2", claim: "BTC 6H 新闻情绪中性，无恐慌 / 狂热", stance: "neutral", weight: 0, sourceRefs: ["E7"] },
    { id: "c1", claim: "无 BTC 持仓，可用 12.51 USDT", stance: "constraint", weight: 0, sourceRefs: ["E6"] }
  ]
}, "账本已记录 11 条", ledgerBase + 26_000);
ledgerTool("lc-ledger-2", "research.recordEvidence", {}, {
  ledgerId: "ledger-preview-2",
  instId: "BTC-USDT-SWAP",
  displayOnly: true,
  recordedAt: ledgerBase + 31_000,
  items: [{ id: "b1", claim: "4H 趋势 66,928 → 62,700，仍处下降通道", stance: "bear", weight: 2.5, sourceRefs: ["E1"], revisionNote: "反方审查：4H 已出现高低点抬升迹象" }]
}, "账本修订 1 条", ledgerBase + 31_000);
ledgerTool("lc-decision", "research.recordDecision", {}, {
  decisionId: "decision-preview",
  instId: "BTC-USDT-SWAP",
  outcome: "abstain",
  reason: "价格处于 64,000–64,700 震荡区间中部，既无支撑位回踩机会，也未确认突破；等待证据收敛。",
  wakeConditions: [
    { kind: "price_below", price: 63_800, note: "可能形成支撑位回踩的做多候选" },
    { kind: "price_above", price: 64_700, note: "确认反弹延续的做多 / 突破候选" },
    { kind: "time", afterMinutes: 240, dueAt: ledgerBase + 33_000 + 240 * 60_000, note: "无论价格如何，周期性复查" }
  ],
  displayOnly: true,
  recordedAt: ledgerBase + 33_000
}, "决策：放弃", ledgerBase + 33_000);

export const previewEvidenceLedgerMessage = storedMessageToUiMessage({
  id: "preview-evidence-ledger",
  sessionId: "session-preview-user",
  role: "assistant",
  content: [
    "**本轮决策：放弃（证据冲突）**",
    "",
    "偏空合计 7.5，偏多合计 7.0，冲突度 97%。价格处于 64,000–64,700 震荡区间中部，既无支撑位回踩机会，也未确认突破。**不交易也是有效决策**，等待证据收敛。"
  ].join("\n"),
  status: "completed",
  toolJson: JSON.stringify(ledgerEvents),
  createdAt: ledgerBase
});

/** 预览：一轮完整的「分析 → 创建交易机会 → 记录决策」，用来看结论卡。 */
const previewVerdictMessage: AiUiMessage = {
  id: "preview-verdict-ai",
  role: "assistant",
  completed: true,
  startedAt: ledgerBase - 150_000,
  completedAt: ledgerBase - 6_000,
  createdAt: ledgerBase - 150_000,
  text: "推荐 SOL-USDT-SWAP 做多，用回调限价单而不是追高。\n\n- 4H 站在 EMA20 上方，近三个闭合 4H 桶主动买盘净额为正\n- 资金费率 +0.0068%，没有多头拥挤\n- 现价贴近 24h 高点，所以用 118.00 回调限价而不是市价追\n\n机会已保存为待审批记录 `opp1791049559866866021000e96a11de`，未提交订单。",
  tools: [
    { id: "pv-1", name: "market.readCandles", status: "done", ok: true, arguments: { instId: "SOL-USDT-SWAP", bar: "4H" }, result: { instId: "SOL-USDT-SWAP" }, startedAt: ledgerBase - 140_000, endedAt: ledgerBase - 139_000 },
    {
      id: "pv-2", name: "tradeOpportunity.create", status: "done", ok: true, startedAt: ledgerBase - 60_000, endedAt: ledgerBase - 58_000,
      arguments: { direction: "long", instId: "SOL-USDT-SWAP", price: "118", stopLoss: { triggerPx: "116.2" }, takeProfit: { triggerPx: "123.3" }, size: "0.2", lever: "3", expiresAt: Date.now() + 30 * 3_600_000, confidence: 0.5, strategyName: "SOL 区间下沿回调做多（34 小时窗口）" },
      result: { id: "opp1791049559866866021000e96a11de", instId: "SOL-USDT-SWAP", direction: "long" }
    },
    { id: "pv-3", name: "research.recordDecision", status: "done", ok: true, startedAt: ledgerBase - 50_000, endedAt: ledgerBase - 49_000, arguments: { instId: "SOL-USDT-SWAP", outcome: "long", reason: "选 SOL 做多：证据完整。" }, result: { outcome: "long", instId: "SOL-USDT-SWAP", reason: "选 SOL 做多：证据完整。但现价贴近区间上沿，因此不追高。" } }
  ],
  approvals: []
};

export const previewAiMessages: AiUiMessage[] = [
  { id: "preview-verdict-user", role: "user", text: "100U 开仓推荐：交易对、方向与止盈止损", tools: [], approvals: [], createdAt: ledgerBase - 152_000 },
  previewVerdictMessage,
  {
    id: "preview-ledger-user",
    role: "user",
    text: "BTC 现在适合开仓吗？结合盘口、资金和新闻给我判断",
    tools: [],
    approvals: [],
    createdAt: ledgerBase - 2_000
  },
  { ...previewEvidenceLedgerMessage, completed: true, startedAt: ledgerBase, completedAt: ledgerBase + 40_000 },
  {
    id: "preview-user",
    role: "user",
    text: "检查 BTC 当前盘口、最近成交和 5m K 线，给出风险提示。",
    tools: [],
    approvals: [],
    createdAt: Date.now() - 60_000
  },
  {
    id: "preview-ai",
    role: "assistant",
    text: [
      "BTC-USDT-SWAP 当前短线波动放大，盘口买卖压力接近均衡。",
      "",
      "- 先确认账户环境、杠杆、可用保证金和止损位置",
      "- 若价格跌破盘口支撑，避免追多",
      "",
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| 盘口 | 接近均衡 |",
      "| 风险 | 中等偏高 |",
      "",
      "```text",
      "只读分析，不执行下单。",
      "```"
    ].join("\n"),
    reasoning: "先读取只读市场上下文，再判断盘口压力、成交主动性和 K 线连续性。交易建议必须保留风险提示，不执行下单动作。",
    tools: [
      {
        id: "preview-candles",
        name: "market.readCandles",
        arguments: { instId: "BTC-USDT-SWAP", bar: "5m", limit: 12 },
        result: {
          instId: "BTC-USDT-SWAP",
          bar: "5m",
          latestConfirmedAt: Date.now() - 300_000,
          candles: [
            [0, 62820, 62910, 62790, 62870], [1, 62870, 63040, 62810, 62980], [2, 62980, 63120, 62920, 63040],
            [3, 63040, 63140, 62960, 63010], [4, 63010, 63190, 62980, 63120], [5, 63120, 63220, 63040, 63080],
            [6, 63080, 63110, 62990, 63020], [7, 63020, 63180, 63000, 63130], [8, 63130, 63260, 63080, 63220],
            [9, 63220, 63310, 63140, 63200], [10, 63200, 63280, 63080, 63120], [11, 63120, 63210, 63060, 63088]
          ].map(([offset, open, high, low, close]) => ({ time: Date.now() - (12 - offset) * 300_000, open, high, low, close, volume: 120 + offset * 15, confirm: true }))
        },
        summary: "BTC-USDT-SWAP 5m 最近 12 根 K 线，收盘 63,088.0",
        ok: true,
        allowed: true,
        blocked: false,
        policy: "allowed:readonly-tool",
        status: "done"
      },
      {
        id: "preview-ticker",
        name: "market.readTicker",
        arguments: { instId: "BTC-USDT-SWAP" },
        result: { instId: "BTC-USDT-SWAP", last: "63088.0", latencyMs: 212 },
        summary: "BTC-USDT-SWAP 最新价 63,088.0，延迟 212ms",
        ok: true,
        allowed: true,
        blocked: false,
        policy: "allowed:readonly-tool",
        status: "done"
      },
      {
        id: "preview-skill-read",
        name: "skill.read",
        arguments: { skillId: "trading-philosophy" },
        result: {},
        summary: "已读取交易哲学 Skill",
        ok: true,
        allowed: true,
        blocked: false,
        policy: "allowed:session-tool",
        status: "done"
      },
      {
        id: "preview-strategy-create",
        name: "strategy.create",
        arguments: { name: "BTC 确认趋势", description: "仅在确认 15m 收线后评估趋势", source: "def on_bar(ctx):\n    bars = ctx.market.bars(ctx.instrument_id, '15m', lookback=36)\n    if not bars[-1].confirmed:\n        return ctx.no_action('wait for confirmed 15m close')\n    return ctx.no_action('research starter')", parameters: {} },
        result: { strategy: { id: "preview-strategy", name: "BTC 确认趋势", version: 1, status: "active", description: "仅在确认 15m 收线后评估趋势", definition: { source: "def on_bar(ctx):\n    bars = ctx.market.bars(ctx.instrument_id, '15m', lookback=36)\n    if not bars[-1].confirmed:\n        return ctx.no_action('wait for confirmed 15m close')\n    return ctx.no_action('research starter')" } }, createdVersion: true, saved: true },
        summary: "已创建只读 Python 研究策略版本 1",
        ok: true,
        allowed: true,
        blocked: false,
        policy: "allowed:strategy-research",
        status: "done"
      },
      {
        id: "preview-tasks",
        name: "todo_write",
        arguments: {
          todos: [
            { id: "market", content: "读取盘口与最近成交", status: "completed" },
            { id: "structure", content: "检查 5m 结构与失效位", status: "in_progress" },
            { id: "risk", content: "整理风险提示", status: "pending" }
          ]
        },
        summary: "更新研究任务",
        ok: true,
        allowed: true,
        blocked: false,
        policy: "allowed:session-tool",
        status: "done"
      }
    ],
    approvals: [],
    agents: [
      {
        id: "preview-agent-market",
        role: "market-analyst",
        title: "行情结构分析",
        task: "读取盘口、成交与 5m K 线，输出短线风险摘要。",
        status: "done",
        result: "盘口接近平衡，短线波动扩大。"
      }
    ],
    contextUsage: {
      usedTokens: 47_200,
      contextWindow: 256_000,
      measuredAt: Date.now() - 2_000,
      usedSource: "clineMessages",
      contextWindowSource: "clineModelCatalog"
    },
    createdAt: Date.now() - 48_000,
    startedAt: Date.now() - 48_000,
    firstTokenAt: Date.now() - 46_800,
    status: "生成中"
  }
];

export const previewAiSessions: AiSession[] = [
  {
    id: "session-preview-user",
    title: "BTC 盘面咨询",
    status: "streaming",
    origin: "user",
    createdAt: 1_784_810_000_000,
    updatedAt: 1_784_810_060_000
  },
  {
    id: "background:preview-run",
    title: "BTC 定时扫描",
    status: "idle",
    origin: "automation",
    createdAt: 1_784_809_000_000,
    updatedAt: 1_784_810_030_000
  },
  {
    id: "review:preview-review",
    title: "自动交易复盘",
    status: "idle",
    origin: "automation",
    createdAt: 1_784_808_000_000,
    updatedAt: 1_784_809_000_000
  }
];

export const previewRadarAssets: MarketAssetsSummary = {
  cacheDir: "cache/market-assets",
  total: 8,
  iconCached: 8,
  iconFailed: 0,
  updatedAt: Date.now(),
  instruments: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "AVAX", "AAPL"].map((baseCcy, index) => ({
    instId: `${baseCcy}-USDT-SWAP`,
    instType: "SWAP",
    state: "live",
    settleCcy: "USDT",
    baseCcy,
    instFamily: `${baseCcy}-USDT`,
    listTime: String(1_704_067_200_000 + index * 86_400_000),
    iconPath: `cache/market-assets/icons/${baseCcy}.png`,
    iconCached: true,
    quoteCcy: "USDT",
    ctVal: "",
    ctValCcy: "",
    ctType: "",
    tickSz: "",
    lotSz: "",
    minSz: "",
    maxLmtSz: "",
    maxMktSz: "",
    maxLmtAmt: "",
    maxMktAmt: "",
    lever: "",
    updatedAt: Date.now()
  }))
};
export const previewRadarTickers: Ticker[] = previewRadarAssets.instruments.map((instrument, index) => ({
  instId: instrument.instId,
  last: String(100 + index * 12),
  open24h: String(100 + index * 10),
  high24h: String(112 + index * 14),
  low24h: String(94 + index * 9),
  bidPx: String(99 + index * 12),
  askPx: String(101 + index * 12),
  volCcy24h: String(12_000 + index * 8_000),
  lastSz: "1",
  askSz: "10",
  bidSz: "10",
  vol24h: String(12_000 + index * 8_000),
  ts: Date.now()
}));
