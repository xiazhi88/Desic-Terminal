import type { OkxAlgoOrder, OkxPendingOrder, OkxPosition } from "../types";

const ALGO_ORDER_TYPES = new Set([
  "conditional",
  "oco",
  "trigger",
  "move_order_stop",
  "iceberg",
  "twap"
]);

export function isOrdinaryPendingOrder(
  order: Pick<OkxPendingOrder, "isAlgo" | "algoId" | "algoClOrdId" | "ordType">
): boolean {
  if (order.isAlgo || order.algoId || order.algoClOrdId) return false;
  return !ALGO_ORDER_TYPES.has(String(order.ordType ?? "").trim().toLowerCase());
}

function pendingOrderToAlgoOrder(
  order: OkxPendingOrder,
  accountId: string,
  environment: string
): OkxAlgoOrder {
  return {
    accountId,
    environment,
    instId: order.instId,
    instType: order.instType ?? "SWAP",
    algoId: order.algoId || order.ordId,
    algoClOrdId: order.algoClOrdId || order.clOrdId,
    ordId: order.ordId,
    clOrdId: order.clOrdId,
    side: order.side,
    posSide: order.posSide,
    tdMode: order.tdMode,
    ordType: order.ordType,
    state: order.state,
    sz: order.sz,
    actualSide: "",
    actualSz: order.accFillSz,
    triggerPx: order.triggerPx ?? "",
    triggerPxType: order.triggerPxType ?? "",
    ordPx: order.ordPx ?? order.px,
    tpTriggerPx: order.tpTriggerPx ?? "",
    tpTriggerPxType: order.tpTriggerPxType ?? "",
    tpOrdPx: order.tpOrdPx ?? "",
    slTriggerPx: order.slTriggerPx ?? "",
    slTriggerPxType: order.slTriggerPxType ?? "",
    slOrdPx: order.slOrdPx ?? "",
    reduceOnly: order.reduceOnly,
    failCode: "",
    triggerTime: "",
    cTime: order.cTime,
    uTime: order.uTime,
    operator: "user",
    sourceEndpoint: "private-snapshot"
  };
}

function algoOrderIdentity(order: Pick<OkxAlgoOrder, "algoId" | "algoClOrdId" | "ordId" | "clOrdId">): string {
  return order.algoId || order.algoClOrdId || order.ordId || order.clOrdId;
}

export type OrdinaryPendingOrderGroup = "limitMarket" | "advancedLimit";
export type AlgoPendingOrderGroup = "takeProfitStopLoss" | "trailing" | "planned" | "other";

export function classifyOrdinaryPendingOrderGroup(ordType: string | null | undefined): OrdinaryPendingOrderGroup {
  const normalized = String(ordType ?? "").trim().toLowerCase();
  return normalized === "limit" || normalized === "market" ? "limitMarket" : "advancedLimit";
}

export function classifyAlgoPendingOrderGroup(ordType: string | null | undefined): AlgoPendingOrderGroup {
  const normalized = String(ordType ?? "").trim().toLowerCase();
  if (normalized === "conditional" || normalized === "oco") return "takeProfitStopLoss";
  if (normalized === "move_order_stop") return "trailing";
  if (normalized === "trigger") return "planned";
  return "other";
}

export type AlgoTriggerPurpose = "entry" | "takeProfit" | "stopLoss" | "close";

export function classifyAlgoTriggerPurpose(
  order: Pick<OkxAlgoOrder, "instId" | "ordType" | "side" | "posSide" | "reduceOnly" | "triggerPx">,
  positions: Array<Pick<OkxPosition, "instId" | "posSide" | "pos" | "markPx">>
): AlgoTriggerPurpose | null {
  if (String(order.ordType).trim().toLowerCase() !== "trigger") return null;

  let closingSide: "long" | "short" | null = null;
  if (order.posSide === "long" && order.side === "sell") closingSide = "long";
  if (order.posSide === "short" && order.side === "buy") closingSide = "short";
  if (order.posSide === "net" && String(order.reduceOnly).toLowerCase() === "true") {
    const netPosition = positions.find((position) => position.instId === order.instId && position.posSide === "net");
    const netSize = Number(netPosition?.pos);
    if (Number.isFinite(netSize) && netSize > 0 && order.side === "sell") closingSide = "long";
    if (Number.isFinite(netSize) && netSize < 0 && order.side === "buy") closingSide = "short";
  }
  if (!closingSide) return "entry";

  const position = positions.find((item) => item.instId === order.instId && (item.posSide === closingSide || item.posSide === "net"));
  const referencePrice = Number(position?.markPx);
  const triggerPrice = Number(order.triggerPx);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(triggerPrice) || triggerPrice <= 0 || triggerPrice === referencePrice) return "close";
  if (closingSide === "long") return triggerPrice < referencePrice ? "stopLoss" : "takeProfit";
  return triggerPrice > referencePrice ? "stopLoss" : "takeProfit";
}

export function mergePendingAlgoOrders(
  apiOrders: OkxAlgoOrder[],
  snapshotOrders: OkxPendingOrder[],
  accountId: string,
  environment: string
): OkxAlgoOrder[] {
  const merged = new Map<string, OkxAlgoOrder>();
  for (const order of snapshotOrders) {
    if (isOrdinaryPendingOrder(order)) continue;
    const normalized = pendingOrderToAlgoOrder(order, accountId, environment);
    const identity = algoOrderIdentity(normalized);
    if (identity) merged.set(identity, normalized);
  }
  for (const order of apiOrders) {
    const identity = algoOrderIdentity(order);
    if (!identity) continue;
    merged.set(identity, { ...merged.get(identity), ...order });
  }
  return [...merged.values()].sort((left, right) => Number(right.uTime || right.cTime) - Number(left.uTime || left.cTime));
}
