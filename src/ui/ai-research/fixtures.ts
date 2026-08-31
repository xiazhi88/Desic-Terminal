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

export const previewAiMessages: AiUiMessage[] = [
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
