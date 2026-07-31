import type {
  OrderSpecV2,
  OrderSpecV2OrderType,
  OrderSpecV2TriggerSource,
  PlaceOrderRequest,
} from "../../types";

export type TradeTicketAction = "long" | "short" | "close-long" | "close-short";

export type TradeTicketDraft = {
  orderType: OrderSpecV2OrderType;
  price: string;
  size: string;
  triggerSource: OrderSpecV2TriggerSource;
  triggerExecution: "market" | "limit";
  triggerOrderPrice: string;
  trailingActivePrice: string;
  trailingCallbackRatio: string;
};

export type PreparedTradeOrder = {
  executionKey: string;
  request: PlaceOrderRequest;
  spec: OrderSpecV2;
  action: TradeTicketAction;
  displayPrice: string;
  displaySize: string;
  notional?: number;
  estimatedMargin?: number;
  estimatedFee?: number;
  takeProfitPrice?: string;
  stopLossPrice?: string;
  trailingCallbackPercent?: string;
  createdAt: number;
};

export function createTradeExecutionKey(accountId: string, environment: string, instId: string) {
  const randomPart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2, 14);
  return `manual:${accountId}:${environment}:${instId}:${Date.now()}:${randomPart}`;
}

export function createTradeAlgoClientId(prefix = "m") {
  const randomPart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2, 18);
  return `${prefix}${Date.now().toString(36)}${randomPart}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

export function legacyOrderType(orderType: OrderSpecV2OrderType): PlaceOrderRequest["orderType"] {
  if (orderType === "market") return "market";
  if (orderType === "trigger" || orderType === "trailing") return "trigger";
  return "limit";
}

export function buildOrderSpecV2(draft: Pick<TradeTicketDraft,
  "orderType" | "price" | "triggerSource" | "triggerExecution" | "triggerOrderPrice" | "trailingActivePrice" | "trailingCallbackRatio"
>): OrderSpecV2 {
  const spec: OrderSpecV2 = {
    version: 2,
    requestedOrderType: draft.orderType,
  };
  if (draft.orderType === "trigger") {
    spec.trigger = {
      source: draft.triggerSource,
      triggerPrice: draft.price,
      execution: draft.triggerExecution,
      ...(draft.triggerExecution === "limit" && draft.triggerOrderPrice
        ? { orderPrice: draft.triggerOrderPrice }
        : {}),
    };
  }
  if (draft.orderType === "trailing") {
    const callbackPercent = Number(draft.trailingCallbackRatio);
    const callbackRatio = Number.isFinite(callbackPercent)
      ? (callbackPercent / 100).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")
      : "";
    spec.trailing = {
      source: "last",
      callbackRatio,
      ...(draft.trailingActivePrice ? { activePx: draft.trailingActivePrice } : {}),
    };
  }
  return spec;
}

export function actionForTradeHotkey(code: string, ticketMode: "open" | "close"): TradeTicketAction | null {
  if (code === "KeyB") return ticketMode === "open" ? "long" : "close-short";
  if (code === "KeyS") return ticketMode === "open" ? "short" : "close-long";
  return null;
}

export function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], .cm-editor"));
}

export function hasVisibleTradeHotkeyBlocker() {
  if (typeof document === "undefined") return true;
  const selectors = [
    "[aria-modal='true']",
    "[role='dialog']",
    "[role='menu']",
    "[role='listbox']",
    ".notification-center",
    ".ai-dock.open",
    ".first-launch-onboarding",
  ];
  return [...document.querySelectorAll<HTMLElement>(selectors.join(","))]
    .some((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
}
