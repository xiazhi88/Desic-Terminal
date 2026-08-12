import type {
  ChartOrderLine,
  ChartOrderLineEdit,
  ChartRiskRewardTradeIntent,
  AccountSummary,
  OkxInstrumentSummary,
  OkxPosition,
  PositionLineTradeIntent,
  PrivateAccountSnapshot,
} from "../types";
import {
  amendOkxAlgoOrder,
  amendOkxOrder,
  cancelOkxOrder,
  closeOkxPosition,
  placeOkxAlgoOrder,
  placeOkxOrder,
} from "./okx";

type InstrumentRules = Pick<OkxInstrumentSummary, "tickSz" | "lotSz" | "minSz">;

export type ChartTradeActionContext = {
  accountId: string;
  environment: "demo" | "live";
  account?: AccountSummary | null;
  defaultInstId?: string;
  snapshot?: PrivateAccountSnapshot | null;
  instruments?: Map<string, InstrumentRules> | Record<string, InstrumentRules | undefined>;
  getInstrument?: (instId: string) => InstrumentRules | undefined;
};

export type ChartTradeActionResult = {
  ordId?: string;
  clOrdId?: string;
  algoId?: string;
  algoClOrdId?: string;
  sCode?: string;
  sMsg?: string;
};

function instrumentFor(context: ChartTradeActionContext, instId: string) {
  return context.getInstrument?.(instId)
    ?? (context.instruments instanceof Map ? context.instruments.get(instId) : context.instruments?.[instId]);
}

function requireLiveConfirmation(context: ChartTradeActionContext, confirmedLive?: boolean) {
  if (context.environment === "live" && confirmedLive !== true) {
    throw new Error("Live trading confirmation is required before submitting this chart action.");
  }
}

function decimalPlaces(step?: string) {
  const text = String(step ?? "").trim().toLowerCase();
  if (!text) return 0;
  if (text.includes("e-")) return Math.min(12, Number(text.split("e-")[1]) || 0);
  return Math.max(0, Math.min(12, (text.split(".")[1] ?? "").replace(/0+$/, "").length));
}

function formatStep(value: number, instrument?: InstrumentRules) {
  const digits = Math.max(decimalPlaces(instrument?.lotSz), decimalPlaces(instrument?.minSz));
  return value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/** Round down to exchange-valid lot/min size and cap at max when provided. */
export function normalizeChartSize(value: string | number, instrument?: InstrumentRules, options: { max?: string | number; enforceMin?: boolean } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !instrument) return "";
  const lot = Number(instrument.lotSz);
  const min = Number(instrument.minSz);
  if (!Number.isFinite(lot) || lot <= 0) return "";
  const max = Number(options.max);
  const capped = Number.isFinite(max) && max > 0 ? Math.min(numeric, max) : numeric;
  const rounded = Math.floor((capped + lot * 1e-9) / lot) * lot;
  if (rounded <= 0) return "";
  if (options.enforceMin !== false && Number.isFinite(min) && min > 0 && rounded < min) return min <= capped ? formatStep(min, instrument) : "";
  if (options.enforceMin === false && Number.isFinite(min) && min > 0 && rounded < min) return "";
  return formatStep(rounded, instrument);
}

/** Round to the nearest valid tick while preserving decimal precision. */
export function normalizeChartPrice(value: string | number, instrument?: InstrumentRules) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const tick = Number(instrument?.tickSz);
  if (!Number.isFinite(tick) || tick <= 0) return String(numeric);
  return (Math.round((numeric + Number.EPSILON) / tick) * tick).toFixed(decimalPlaces(instrument?.tickSz)).replace(/0+$/, "").replace(/\.$/, "");
}

export function isChartAlgoLine(line: Pick<ChartOrderLine, "source" | "algoId" | "algoClientOrderId" | "editKind">) {
  return line.source === "algo"
    || Boolean(line.algoId || line.algoClientOrderId)
    || line.editKind === "algo-trigger"
    || line.editKind === "algo-tp"
    || line.editKind === "algo-sl";
}

function executionKey(context: ChartTradeActionContext, instId: string, provided?: string | null) {
  if (provided) return provided;
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2, 14);
  return `manual:${context.accountId}:${context.environment}:${instId}:${Date.now()}:${random}`;
}

function requireIdentity(line: ChartOrderLine) {
  if (!line.orderId && !line.clientOrderId && !line.algoId && !line.algoClientOrderId) throw new Error("The chart order is missing an OKX order identity.");
}

export async function amendChartOrder(context: ChartTradeActionContext, edit: ChartOrderLineEdit, confirmedLive = false): Promise<ChartTradeActionResult | null> {
  requireLiveConfirmation(context, confirmedLive);
  const line = edit.line;
  requireIdentity(line);
  const instId = line.instId || context.defaultInstId || "";
  if (!instId) throw new Error("The chart order is missing its instrument.");
  const instrument = instrumentFor(context, instId);
  const nextPrice = normalizeChartPrice(edit.price, instrument);
  if (!nextPrice) throw new Error("Amendment price is invalid or not aligned to tickSz.");
  if (line.editKind === "order-price") {
    return amendOkxOrder({
      accountId: context.accountId,
      environment: context.environment,
      instId,
      ordId: line.orderId,
      clOrdId: line.clientOrderId,
      newSize: line.size ? normalizeChartSize(line.size, instrument) : undefined,
      newPrice: nextPrice,
      confirmedLive,
      executionKey: executionKey(context, instId, line.executionKey),
    });
  }
  if (line.editKind !== "algo-trigger" && line.editKind !== "algo-tp" && line.editKind !== "algo-sl") throw new Error("This chart line is not editable.");
  const triggerPrice = line.editKind === "algo-trigger" ? normalizeChartPrice(edit.triggerPrice ?? edit.price, instrument) : undefined;
  const orderPrice = line.editKind === "algo-trigger"
    ? edit.orderPrice === null ? "-1" : normalizeChartPrice(edit.orderPrice ?? line.orderPrice ?? 0, instrument)
    : undefined;
  if (line.editKind === "algo-trigger" && (!triggerPrice || !orderPrice)) throw new Error("Trigger and execution prices must satisfy tickSz.");
  return amendOkxAlgoOrder({
    accountId: context.accountId,
    environment: context.environment,
    instId,
    algoId: line.algoId,
    algoClOrdId: line.algoClientOrderId,
    newSize: line.size ? normalizeChartSize(line.size, instrument) : undefined,
    newTriggerPx: triggerPrice,
    newOrdPx: orderPrice,
    newTpTriggerPx: line.editKind === "algo-tp" ? nextPrice : undefined,
    newSlTriggerPx: line.editKind === "algo-sl" ? nextPrice : undefined,
    confirmedLive,
    executionKey: executionKey(context, instId, line.executionKey),
  });
}

export async function cancelChartOrder(context: ChartTradeActionContext, line: ChartOrderLine, confirmedLive = false) {
  requireLiveConfirmation(context, confirmedLive);
  requireIdentity(line);
  const instId = line.instId || context.defaultInstId || "";
  if (!instId) throw new Error("The chart order is missing its instrument.");
  return cancelOkxOrder({
    accountId: context.accountId,
    environment: context.environment,
    instId,
    confirmedLive,
    ordId: line.orderId,
    clOrdId: line.clientOrderId,
    isAlgo: isChartAlgoLine(line),
    algoId: line.algoId,
    algoClOrdId: line.algoClientOrderId,
  });
}

function findPosition(context: ChartTradeActionContext, intent: PositionLineTradeIntent) {
  const position = context.snapshot?.positions.find((item) => item.instId === intent.instId
    && (intent.posSide === "net" ? item.posSide === "net" : item.posSide.toLowerCase() === intent.posSide)
    && Math.abs(Number(item.pos)) > 0);
  if (!position) throw new Error("The position changed or is no longer actionable.");
  return position;
}

function positionSide(position: OkxPosition): "buy" | "sell" {
  const normalized = position.posSide.toLowerCase();
  if (normalized === "short") return "buy";
  if (normalized === "long") return "sell";
  return Number(position.pos) < 0 ? "buy" : "sell";
}

export async function submitPositionChartAction(context: ChartTradeActionContext, intent: PositionLineTradeIntent, size: string, orderPx: string, confirmedLive = false) {
  requireLiveConfirmation(context, confirmedLive);
  const position = findPosition(context, intent);
  const instrument = instrumentFor(context, intent.instId);
  const maxSize = Math.abs(Number(position.pos));
  const normalizedSize = normalizeChartSize(size, instrument, { max: maxSize, enforceMin: false });
  if (!normalizedSize || Number(normalizedSize) <= 0 || Number(normalizedSize) > maxSize + 1e-9) throw new Error("Quantity exceeds the actionable position or violates minSz/lotSz.");
  const side = positionSide(position);
  if (intent.side !== side) throw new Error("Position direction changed; refresh the chart before submitting.");
  const tdMode = position.mgnMode === "isolated" ? "isolated" : "cross";
  if (intent.kind === "market_close") {
    return closeOkxPosition({ accountId: context.accountId, environment: context.environment, instId: intent.instId, mgnMode: tdMode, posSide: intent.posSide, confirmedLive });
  }
  const targetPrice = normalizeChartPrice(intent.targetPrice, instrument);
  if (!targetPrice) throw new Error("Target price is invalid or not aligned to tickSz.");
  if (intent.kind === "limit_close") {
    return placeOkxOrder({ accountId: context.accountId, environment: context.environment, instId: intent.instId, tdMode, orderType: "limit", ticketMode: "close", action: side === "buy" ? "close-short" : "close-long", price: targetPrice, size: normalizedSize, lever: position.lever || "1", confirmedLive, operator: "user", executionKey: executionKey(context, intent.instId) });
  }
  const targetSide = intent.existingAlgoSide ?? (intent.kind === "take_profit" ? "tp" : "sl");
  if (intent.existingAlgoId || intent.existingAlgoClientOrderId) {
    return amendOkxAlgoOrder({ accountId: context.accountId, environment: context.environment, instId: intent.instId, algoId: intent.existingAlgoId, algoClOrdId: intent.existingAlgoClientOrderId, newSize: normalizedSize, newTpTriggerPx: targetSide === "tp" ? targetPrice : undefined, newTpOrdPx: targetSide === "tp" ? orderPx || "-1" : undefined, newSlTriggerPx: targetSide === "sl" ? targetPrice : undefined, newSlOrdPx: targetSide === "sl" ? orderPx || "-1" : undefined, confirmedLive, executionKey: executionKey(context, intent.instId) });
  }
  return placeOkxAlgoOrder({ accountId: context.accountId, environment: context.environment, instId: intent.instId, tdMode, posSide: intent.posSide, side, ordType: "conditional", size: normalizedSize, tpTriggerPx: targetSide === "tp" ? targetPrice : undefined, tpOrdPx: targetSide === "tp" ? orderPx || "-1" : undefined, slTriggerPx: targetSide === "sl" ? targetPrice : undefined, slOrdPx: targetSide === "sl" ? orderPx || "-1" : undefined, confirmedLive, operator: "user", executionKey: executionKey(context, intent.instId) });
}

export async function submitRiskRewardChartAction(context: ChartTradeActionContext, intent: ChartRiskRewardTradeIntent, size: string, tdMode: "cross" | "isolated", lever: string, confirmedLive = false) {
  requireLiveConfirmation(context, confirmedLive);
  const instrument = instrumentFor(context, intent.instId);
  const normalizedSize = normalizeChartSize(size, instrument);
  const entryPrice = normalizeChartPrice(intent.entryPrice, instrument);
  const takeProfitPrice = normalizeChartPrice(intent.takeProfitPrice, instrument);
  const stopLossPrice = normalizeChartPrice(intent.stopLossPrice, instrument);
  if (!normalizedSize || !entryPrice || (intent.action === "bracket" && (!takeProfitPrice || !stopLossPrice))) throw new Error("Quantity and prices must satisfy minSz/lotSz/tickSz.");
  return placeOkxOrder({
    accountId: context.accountId,
    instId: intent.instId,
    tdMode,
    orderType: "limit",
    ticketMode: "open",
    action: intent.side,
    price: entryPrice,
    size: normalizedSize,
    lever,
    environment: context.environment,
    confirmedLive,
    operator: "user",
    executionKey: executionKey(context, intent.instId),
    attachAlgoOrds: intent.action === "bracket" ? [{ attachAlgoClOrdId: `chart-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`, tpTriggerPx: takeProfitPrice, tpOrdPx: "-1", tpTriggerPxType: "last", slTriggerPx: stopLossPrice, slOrdPx: "-1", slTriggerPxType: "last", sz: normalizedSize }] : undefined,
  });
}
