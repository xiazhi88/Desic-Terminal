import type { OkxAlgoOrder, OkxPendingOrder } from "../types";

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
