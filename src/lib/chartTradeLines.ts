import type { TFunction } from "i18next";
import type { ChartOrderLine, ChartPositionRange, OkxAlgoOrder, OkxInstrumentSummary, OkxPendingOrder, OkxPosition, Ticker } from "../types";
import { chartOrderVisual, chartPositionLabel, formatChartOrderLabel, formatChartPosition, normalizeChartPosSide } from "./chartTradeSemantics";

const TERMINAL_STATES = new Set(["filled", "canceled", "cancelled", "failed", "rejected", "mmp_canceled", "order_failed", "effective", "triggered"]);

export function isActiveChartPendingOrder(order: Pick<OkxPendingOrder, "state">) {
  return !TERMINAL_STATES.has(String(order.state ?? "").toLowerCase());
}

export function isActiveChartAlgoOrder(order: Pick<OkxAlgoOrder, "state" | "sourceEndpoint">) {
  const state = String(order.state ?? "").toLowerCase();
  return !TERMINAL_STATES.has(state) && (order.sourceEndpoint === "orders-algo-pending" || state === "live" || state === "partially_effective");
}

function estimatePositionPnl(position: OkxPosition, price: number, size: string | undefined, instrument?: OkxInstrumentSummary) {
  const entry = Number(position.avgPx);
  const qty = Math.min(Math.abs(Number(size ?? position.pos)), Math.abs(Number(position.pos)));
  const ctVal = Number(instrument?.ctVal);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(ctVal) || ctVal <= 0) return { pnl: undefined, ratio: undefined };
  const short = normalizeChartPosSide(position.posSide, position.pos) === "short";
  const pnl = (short ? entry - price : price - entry) * qty * ctVal;
  return { pnl, ratio: ((short ? entry - price : price - entry) / entry) * 100 };
}

function withEstimate(label: string, position: OkxPosition | undefined, price: number, size: string | undefined, instrument?: OkxInstrumentSummary) {
  if (!position) return label;
  const estimate = estimatePositionPnl(position, price, size, instrument);
  if (!Number.isFinite(estimate.pnl) || !Number.isFinite(estimate.ratio)) return label;
  const sign = Number(estimate.pnl) >= 0 ? "+" : "";
  return `${label} ${sign}${Number(estimate.pnl).toFixed(2)}U ${sign}${Number(estimate.ratio).toFixed(2)}%`;
}

function isReduceOnly(value: boolean | string | undefined) {
  return value === true || String(value ?? "").toLowerCase() === "true";
}

function findClosingLinePosition(positions: OkxPosition[], symbol: string, side?: string, posSide?: string) {
  const active = positions.filter((position) => position.instId === symbol && Math.abs(Number(position.pos)) > 0);
  const requestedPosSide = normalizeChartPosSide(posSide);
  const orderSide = String(side ?? "").toLowerCase();
  const closingPosSide = orderSide === "buy" ? "short" : orderSide === "sell" ? "long" : undefined;
  if (!closingPosSide) return undefined;
  return active.find((position) => {
    const positionSide = normalizeChartPosSide(position.posSide, position.pos);
    return positionSide === closingPosSide && (requestedPosSide === "net" || requestedPosSide === positionSide);
  });
}

export function buildSharedChartOrderLines({
  t,
  symbol,
  orders,
  algoOrders,
  positions,
  instrument,
  overrides = {},
}: {
  t: TFunction;
  symbol: string;
  orders: OkxPendingOrder[];
  algoOrders: OkxAlgoOrder[];
  positions: OkxPosition[];
  instrument?: OkxInstrumentSummary;
  overrides?: Record<string, { price: number; expiresAt: number }>;
}): ChartOrderLine[] {
  type LineInput = {
    id: string;
    type: ChartOrderLine["type"];
    source?: ChartOrderLine["source"];
    side?: string;
    posSide?: string;
    reduceOnly?: boolean | string;
    size?: string;
    orderId?: string;
    clientOrderId?: string;
    algoId?: string;
    algoClientOrderId?: string;
    priceText?: string;
    triggerPrice?: number;
    orderPriceText?: string;
    fallbackLabel: string;
  };
  const lines: ChartOrderLine[] = [];
  const seen = new Set<string>();
  const pendingAlgoKeys = new Set(algoOrders.filter((order) => order.instId === symbol && isActiveChartAlgoOrder(order)).flatMap((order) => [order.algoId, order.algoClOrdId]).filter(Boolean));
  const add = (input: LineInput) => {
    const price = Number(overrides[input.id]?.price ?? input.priceText);
    if (!Number.isFinite(price) || price <= 0) return;
    const identity = input.algoId || input.algoClientOrderId || input.orderId || input.clientOrderId || input.id;
    const dedupe = `${input.type}:${identity}:${price}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    // Opening orders have no realized or unrealized PnL to estimate. A displayed
    // estimate is only meaningful for a protection or explicitly reduce-only order.
    const position = (input.type === "tp" || input.type === "sl" || isReduceOnly(input.reduceOnly))
      ? findClosingLinePosition(positions, symbol, input.side, input.posSide)
      : undefined;
    const visual = chartOrderVisual(input.type, input);
    const editable = input.type === "limit" ? Boolean(input.orderId || input.clientOrderId) : Boolean(input.algoId || input.algoClientOrderId);
    lines.push({
      ...input,
      instId: symbol,
      price,
      label: withEstimate(input.fallbackLabel, position, price, input.size, instrument),
      color: visual.color,
      tone: visual.tone,
      editable,
      editKind: editable ? input.type === "limit" ? "order-price" : input.type === "trigger" ? "algo-trigger" : input.type === "tp" ? "algo-tp" : input.type === "sl" ? "algo-sl" : undefined : undefined,
      triggerPrice: input.type === "trigger" ? Number(input.triggerPrice ?? input.priceText) || undefined : undefined,
      orderPrice: input.orderPriceText === "-1" ? null : Number(input.orderPriceText) || undefined,
    });
  };
  for (const position of positions) {
    if (position.instId !== symbol || Math.abs(Number(position.pos)) <= 0) continue;
    const key = position.posId || `${position.instId}-${position.posSide}`;
    const label = `${chartPositionLabel(position.posSide, position.pos, t)} · ${t("trading:liquidationPrice")}`;
    const price = Number(position.liqPx);
    if (Number.isFinite(price) && price > 0) lines.push({ id: `position-liq-${key}`, type: "liquidation", source: "position", label, price, posSide: position.posSide, color: "#f59e0b", tone: "warning" });
  }
  for (const order of orders) {
    if (order.instId !== symbol || !isActiveChartPendingOrder(order)) continue;
    const id = order.ordId || order.clOrdId || order.algoId || order.algoClOrdId;
    if (!id) continue;
    const type: ChartOrderLine["type"] = order.isAlgo || order.ordType === "trigger" ? "trigger" : "limit";
    add({ id: `order-${id}`, type, source: order.isAlgo ? "algo" : "order", side: order.side, posSide: order.posSide, reduceOnly: order.reduceOnly, size: order.sz, orderId: order.ordId, clientOrderId: order.clOrdId, algoId: order.algoId, algoClientOrderId: order.algoClOrdId, priceText: type === "trigger" ? order.triggerPx || order.px : order.px, triggerPrice: Number(order.triggerPx || order.px) || undefined, orderPriceText: type === "trigger" ? order.ordPx : undefined, fallbackLabel: formatChartOrderLabel(type, order, order.sz, t) });
    const nested = Boolean((order.algoId && pendingAlgoKeys.has(order.algoId)) || (order.algoClOrdId && pendingAlgoKeys.has(order.algoClOrdId)));
    if (!nested) {
      add({ id: `order-${id}-tp`, type: "tp", source: order.algoId || order.algoClOrdId ? "algo" : "order", side: order.side, posSide: order.posSide, reduceOnly: order.reduceOnly, size: order.sz, orderId: order.ordId, clientOrderId: order.clOrdId, algoId: order.algoId, algoClientOrderId: order.algoClOrdId, priceText: order.tpTriggerPx, fallbackLabel: formatChartOrderLabel("tp", order, order.sz, t) });
      add({ id: `order-${id}-sl`, type: "sl", source: order.algoId || order.algoClOrdId ? "algo" : "order", side: order.side, posSide: order.posSide, reduceOnly: order.reduceOnly, size: order.sz, orderId: order.ordId, clientOrderId: order.clOrdId, algoId: order.algoId, algoClientOrderId: order.algoClOrdId, priceText: order.slTriggerPx, fallbackLabel: formatChartOrderLabel("sl", order, order.sz, t) });
    }
  }
  for (const order of algoOrders) {
    if (order.instId !== symbol || !isActiveChartAlgoOrder(order)) continue;
    const id = order.algoId || order.algoClOrdId || `${order.instId}-${order.cTime}`;
    add({ id: `algo-${id}-tp`, type: "tp", source: "algo", side: order.side, posSide: order.posSide, reduceOnly: order.reduceOnly, size: order.sz, algoId: order.algoId, algoClientOrderId: order.algoClOrdId, priceText: order.tpTriggerPx, fallbackLabel: formatChartOrderLabel("tp", order, order.sz, t) });
    add({ id: `algo-${id}-sl`, type: "sl", source: "algo", side: order.side, posSide: order.posSide, reduceOnly: order.reduceOnly, size: order.sz, algoId: order.algoId, algoClientOrderId: order.algoClOrdId, priceText: order.slTriggerPx, fallbackLabel: formatChartOrderLabel("sl", order, order.sz, t) });
  }
  return lines;
}

export function buildSharedChartPositionRanges(t: TFunction, symbol: string, positions: OkxPosition[], ticker: Ticker | null, algoOrders: OkxAlgoOrder[], instrument?: OkxInstrumentSummary): ChartPositionRange[] {
  const pending = algoOrders.filter((order) => order.instId === symbol && isActiveChartAlgoOrder(order));
  const ctVal = Number(instrument?.ctVal);
  const contractValue = Number.isFinite(ctVal) && ctVal > 0 ? ctVal : 1;
  return positions.filter((position) => position.instId === symbol && Math.abs(Number(position.pos)) > 0).map((position) => {
    const existingAlgos: ChartPositionRange["existingAlgos"] = [];
    const closeSide = normalizeChartPosSide(position.posSide, position.pos) === "short" ? "buy" : "sell";
    for (const order of pending) {
      if (normalizeChartPosSide(order.posSide) !== normalizeChartPosSide(position.posSide, position.pos) || String(order.side).toLowerCase() !== closeSide) continue;
      if (order.tpTriggerPx) existingAlgos.push({ side: "tp", algoId: order.algoId, algoClientOrderId: order.algoClOrdId });
      if (order.slTriggerPx) existingAlgos.push({ side: "sl", algoId: order.algoId, algoClientOrderId: order.algoClOrdId });
    }
    return { id: `position-range-${position.posId || position.instId}-${position.posSide}`, instId: position.instId, entryPrice: Number(position.avgPx), currentPrice: Number(position.markPx) > 0 ? Number(position.markPx) : Number(ticker?.last), contractValue, posSide: position.posSide, size: position.pos, pnl: position.upl, pnlRatio: position.uplRatioLastPx || position.uplRatio, label: formatChartPosition(position.posSide, position.pos, t), existingAlgos };
  }).filter((range) => Number.isFinite(range.entryPrice) && range.entryPrice > 0 && Number.isFinite(range.currentPrice) && range.currentPrice > 0);
}
