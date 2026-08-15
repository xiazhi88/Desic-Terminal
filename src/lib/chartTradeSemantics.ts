import type {
  ChartFillMarker,
  ChartOrderLine,
  HistoricalFillSummary,
  TradeOpportunity,
} from "../types";
import type { TFunction } from "i18next";

export type ChartTradeAction = "open-long" | "open-short" | "close-long" | "close-short" | "unknown";

type TradeActionInput = {
  side?: string | null;
  posSide?: string | null;
  action?: string | null;
  direction?: string | null;
  intent?: string | null;
  reduceOnly?: boolean | string | null;
  closePosition?: boolean;
};

const BUY_COLOR = "#f6465d";
const SELL_COLOR = "#0ecb81";
const NEUTRAL_COLOR = "#9ca3af";

function chartLabel(t: TFunction | undefined, key: string, fallback: string, values: Record<string, unknown> = {}) {
  return t ? String(t(key, { defaultValue: fallback, ...values })) : fallback.replace("{{amount}}", String(values.amount ?? ""));
}

export function normalizeChartPosSide(value?: string | null, size?: string | number | null): "long" | "short" | "net" {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "long" || normalized === "short") return normalized;
  const numericSize = Number(size);
  if (Number.isFinite(numericSize) && numericSize !== 0) return numericSize < 0 ? "short" : "long";
  return "net";
}

export function resolveChartTradeAction(input: TradeActionInput): ChartTradeAction {
  const explicitAction = String(input.action ?? "").toLowerCase();
  if (explicitAction === "long" || explicitAction === "open-long") return "open-long";
  if (explicitAction === "short" || explicitAction === "open-short") return "open-short";
  if (explicitAction === "close-long") return "close-long";
  if (explicitAction === "close-short") return "close-short";

  const direction = String(input.direction ?? "").toLowerCase();
  if (input.intent === "close") return direction === "short" ? "close-short" : "close-long";
  if (input.intent === "open") return direction === "short" ? "open-short" : "open-long";

  const side = String(input.side ?? "").toLowerCase();
  const posSide = normalizeChartPosSide(input.posSide);
  const reduceOnly = input.reduceOnly === true || String(input.reduceOnly ?? "").toLowerCase() === "true";
  if (input.closePosition || reduceOnly) {
    if (posSide === "long" || side === "sell") return "close-long";
    if (posSide === "short" || side === "buy") return "close-short";
  }
  if (side === "buy" && posSide === "short") return "close-short";
  if (side === "sell" && posSide === "long") return "close-long";
  if (side === "buy") return "open-long";
  if (side === "sell") return "open-short";
  if (posSide === "long") return "open-long";
  if (posSide === "short") return "open-short";
  return "unknown";
}

export function chartTradeActionLabel(action: ChartTradeAction, t?: TFunction) {
  if (action === "open-long") return chartLabel(t, "trading:long", "做多");
  if (action === "open-short") return chartLabel(t, "trading:short", "做空");
  if (action === "close-long") return chartLabel(t, "trading:closeLong", "平多");
  if (action === "close-short") return chartLabel(t, "trading:closeShort", "平空");
  return chartLabel(t, "trading:trade", "交易");
}

export function chartTradeOpinionLabel(input: Pick<TradeActionInput, "side" | "posSide" | "direction">, t?: TFunction) {
  const action = resolveChartTradeAction(input);
  if (action === "open-long" || action === "close-short") return chartLabel(t, "chart:bullish", "看多");
  if (action === "open-short" || action === "close-long") return chartLabel(t, "chart:bearish", "看空");
  return chartLabel(t, "chart:opinion", "观点");
}

export function chartTradeVisual(action: ChartTradeAction): {
  color: string;
  tone: ChartOrderLine["tone"];
  buyLike: boolean;
} {
  if (action === "open-long" || action === "close-short") {
    return { color: BUY_COLOR, tone: "positive", buyLike: true };
  }
  if (action === "open-short" || action === "close-long") {
    return { color: SELL_COLOR, tone: "negative", buyLike: false };
  }
  return { color: NEUTRAL_COLOR, tone: "neutral", buyLike: true };
}

export function formatChartAmount(value?: string | number | null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return numeric.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatChartQuantity(value?: string | number | null, t?: TFunction) {
  const amount = formatChartAmount(value);
  return amount ? chartLabel(t, "trading:chartQuantity", "{{amount}}张", { amount }) : "";
}

export function formatChartAction(input: TradeActionInput, size?: string | number | null, t?: TFunction) {
  return [chartTradeActionLabel(resolveChartTradeAction(input), t), formatChartQuantity(size, t)].filter(Boolean).join(" ");
}

export function chartPositionLabel(posSide?: string | null, size?: string | number | null, t?: TFunction) {
  const normalized = normalizeChartPosSide(posSide, size);
  if (normalized === "long") return chartLabel(t, "trading:chartLongPosition", "多仓");
  if (normalized === "short") return chartLabel(t, "trading:chartShortPosition", "空仓");
  return chartLabel(t, "trading:chartNetPosition", "净仓");
}

export function formatChartPosition(posSide?: string | null, size?: string | number | null, t?: TFunction) {
  return [chartPositionLabel(posSide, size, t), formatChartPositionQuantity(size, t)].filter(Boolean).join(" ");
}

export function formatChartPositionQuantity(value?: string | number | null, t?: TFunction) {
  const numeric = Number(value);
  return formatChartQuantity(Number.isFinite(numeric) ? Math.abs(numeric) : value, t);
}

export function formatChartOrderLabel(
  type: ChartOrderLine["type"],
  input: Pick<TradeActionInput, "side" | "posSide" | "reduceOnly">,
  size?: string | number | null,
  t?: TFunction,
) {
  const prefix = type === "trigger"
    ? chartLabel(t, "trading:triggerOrder", "计划")
    : type === "tp"
      ? chartLabel(t, "trading:takeProfit", "止盈")
      : type === "sl"
        ? chartLabel(t, "trading:stopLoss", "止损")
        : chartLabel(t, "trading:limit", "限价");
  const action = resolveChartTradeAction({ ...input, closePosition: type === "tp" || type === "sl" });
  return [prefix, chartTradeActionLabel(action, t), formatChartQuantity(size, t)].filter(Boolean).join(" · ");
}

export function chartOrderVisual(
  type: ChartOrderLine["type"],
  input: Pick<TradeActionInput, "side" | "posSide" | "reduceOnly">,
) {
  if (type === "liquidation") return { color: "#f59e0b", tone: "warning" as const, buyLike: true };
  const action = resolveChartTradeAction({ ...input, closePosition: type === "tp" || type === "sl" });
  return chartTradeVisual(action);
}

export function buildHistoricalFillMarkers(
  symbol: string,
  fills: HistoricalFillSummary[],
  limit = 240,
  t?: TFunction,
): ChartFillMarker[] {
  return fills
    .filter((fill) => fill.instId === symbol)
    .slice(0, limit)
    .map((fill) => {
      const action = resolveChartTradeAction(fill);
      const pnl = Number(fill.fillPnl);
      const pnlLabel = Number.isFinite(pnl) && Math.abs(pnl) > 0
        ? `${pnl >= 0 ? "+" : ""}${formatChartAmount(fill.fillPnl)}U`
        : "";
      return {
        id: fill.billId || fill.tradeId || `${fill.instId}-${fill.okxTs}-${fill.fillPx}-${fill.fillSz}`,
        time: Math.floor(Number(fill.okxTs ?? fill.syncedAt) / 1000),
        price: Number(fill.fillPx),
        side: fill.side,
        posSide: fill.posSide,
        size: fill.fillSz,
        pnl: fill.fillPnl,
        orderId: fill.ordId,
        opportunityId: fill.opportunityId,
        executionKey: fill.executionKey,
        operator: fill.operator,
        strategyId: fill.strategyId,
        aiProfileId: fill.aiProfileId,
        strategyName: fill.strategyName,
        aiProfileName: fill.aiProfileName,
        label: [chartTradeActionLabel(action, t), formatChartQuantity(fill.fillSz, t), pnlLabel].filter(Boolean).join(" "),
      };
    })
    .filter((marker) => Number.isFinite(marker.time) && marker.time > 0 && Number.isFinite(marker.price) && marker.price > 0);
}

const EXECUTION_REPRESENTED_STATUSES = new Set<TradeOpportunity["status"]>([
  "executing",
  "submitted",
  "partially_filled",
  "executed",
  "closed",
]);

function sameNonEmpty(left?: string | null, right?: string | null) {
  return Boolean(left && right && left === right);
}

export function opportunityHasExecutionRepresentation(
  opportunity: TradeOpportunity,
  orderLines: ChartOrderLine[],
  fills: ChartFillMarker[],
) {
  if (!EXECUTION_REPRESENTED_STATUSES.has(opportunity.status)) return false;
  const linkedOrder = orderLines.some((line) => (
    sameNonEmpty(opportunity.orderId, line.orderId)
    || sameNonEmpty(opportunity.clientOrderId, line.clientOrderId)
    || sameNonEmpty(opportunity.algoId, line.algoId)
    || sameNonEmpty(opportunity.algoClientOrderId, line.algoClientOrderId)
    || sameNonEmpty(opportunity.id, line.opportunityId)
    || sameNonEmpty(opportunity.executionKey, line.executionKey)
  ));
  if (linkedOrder) return true;
  return fills.some((fill) => (
    sameNonEmpty(opportunity.id, fill.opportunityId)
    || sameNonEmpty(opportunity.executionKey, fill.executionKey)
    || sameNonEmpty(opportunity.orderId, fill.orderId)
  ));
}

export function filterRepresentedTradeOpportunities(
  opportunities: TradeOpportunity[],
  orderLines: ChartOrderLine[],
  fills: ChartFillMarker[],
) {
  return opportunities.filter((opportunity) => !opportunityHasExecutionRepresentation(opportunity, orderLines, fills));
}
