import { useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import type { AccountSummary, ChartOrderLine, ChartOrderLineEdit, OkxInstrumentSummary, OkxPosition, PositionLineTradeIntent } from "../types";
import { fmtPrice } from "../lib/format";
import { normalizeChartPrice, normalizeChartSize } from "../lib/chartTradeActions";
import { useDraggableSurface } from "./useDraggableSurface";
import { useModalFocus } from "./useModalFocus";

function Shell({ title, description, children, onClose, compact = false, className }: { title: string; description?: string; children: ReactNode; onClose: () => void; compact?: boolean; className?: string }) {
  const drag = useDraggableSurface<HTMLElement>();
  useModalFocus({ containerRef: drag.surfaceRef, onClose });
  return <div className={clsx("modal-backdrop", compact && "compact")}><section ref={drag.surfaceRef} className={clsx("modal-shell", compact && "compact", className)} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><header className="modal-head" {...drag.handleProps}><div><strong>{title}</strong>{description && <span>{description}</span>}</div><button type="button" className="window-button" onClick={onClose}>×</button></header>{children}</section></div>;
}

function Confirm({ title, message, onCancel, onConfirm, confirmText }: { title: string; message: string; onCancel: () => void; onConfirm: () => void; confirmText: string }) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLButtonElement | null>(null);
  return <Shell title={title} compact onClose={onCancel}><p>{message}</p><div className="modal-actions"><button type="button" ref={ref} onClick={onCancel}>{t("cancel")}</button><button type="button" className="danger-action" onClick={onConfirm}>{confirmText}</button></div></Shell>;
}

export function SharedChartOrderLineEditDialog({ edit, environment, position, instrument, onClose, onSubmit }: { edit: ChartOrderLineEdit; environment: "demo" | "live"; position?: OkxPosition; instrument?: OkxInstrumentSummary; onClose: () => void; onSubmit: (edit: ChartOrderLineEdit, confirmedLive: boolean) => void | Promise<void> }) {
  const { t } = useTranslation(["trading", "common"]);
  const trigger = edit.line.editKind === "algo-trigger";
  const [price, setPrice] = useState(String(edit.price));
  const [triggerPrice, setTriggerPrice] = useState(String(edit.triggerPrice ?? edit.line.triggerPrice ?? edit.price));
  const initialOrderPrice = edit.orderPrice ?? edit.line.orderPrice;
  const [orderPrice, setOrderPrice] = useState(initialOrderPrice === null ? "-1" : initialOrderPrice ? String(initialOrderPrice) : "");
  const [confirming, setConfirming] = useState(false);
  const next: ChartOrderLineEdit = trigger ? { ...edit, price: Number(triggerPrice), triggerPrice: Number(triggerPrice), orderPrice: orderPrice === "-1" ? null : Number(orderPrice) } : { ...edit, price: Number(price) };
  const normalized = trigger ? normalizeChartPrice(triggerPrice, instrument) : normalizeChartPrice(price, instrument);
  const valid = Boolean(normalized && (!trigger || orderPrice === "-1" || normalizeChartPrice(orderPrice, instrument)));
  const submit = (confirmedLive: boolean) => { void Promise.resolve(onSubmit(next, confirmedLive)).catch(() => undefined); };
  return <><Shell title={trigger ? t("trading:modifyTriggerOrder") : t("trading:modifyOrderPrice")} description={`${edit.line.label} · ${environment === "live" ? t("trading:liveAccount") : t("trading:demoAccount")}`} className="trade-action-modal chart-order-edit-modal" onClose={onClose}><div className="position-line-summary chart-order-edit-summary"><span>{t("trading:originalPrice")} <b>{fmtPrice(edit.line.price)}</b></span><span>{t("trading:modifiedPrice")} <b className="highlight-value">{normalized || "--"}</b></span></div><div className="ticket-form modal-trade-form">{trigger ? <><label>{t("trading:triggerPrice")}</label><input value={triggerPrice} onChange={(event) => setTriggerPrice(event.target.value)} /><label>{t("trading:orderPriceAfterTrigger")}</label><div className="segmented-row"><button type="button" className={orderPrice === "-1" ? "active" : ""} onClick={() => setOrderPrice("-1")}>{t("trading:market")}</button><button type="button" className={orderPrice !== "-1" ? "active" : ""} onClick={() => setOrderPrice(triggerPrice)}>{t("trading:limit")}</button></div>{orderPrice !== "-1" && <input value={orderPrice} onChange={(event) => setOrderPrice(event.target.value)} />}</> : <><label>{t("trading:targetPrice")}</label><input value={price} onChange={(event) => setPrice(event.target.value)} /></>}<button type="button" className={clsx("modal-submit", environment === "live" && "danger")} disabled={!valid} onClick={() => environment === "live" ? setConfirming(true) : submit(false)}>{environment === "live" ? t("trading:confirmLiveModification") : t("trading:confirmModification")}</button></div></Shell>{confirming && <Confirm title={t("trading:confirmModifyLiveOrderTitle")} message={edit.line.label} confirmText={t("trading:confirmAmendOrder")} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); submit(true); }} />}</>;
}

export function SharedChartOrderCancelDialog({ line, environment, onClose, onSubmit }: { line: ChartOrderLine; environment: "demo" | "live"; onClose: () => void; onSubmit: (confirmedLive: boolean) => void | Promise<void> }) {
  const { t } = useTranslation(["trading", "common"]);
  return <Confirm title={t("trading:confirmCancelOrder")} message={`${line.label} · ${fmtPrice(line.price)} · ${environment === "live" ? t("common:live") : t("common:demo")}`} confirmText={t("trading:confirmCancellation")} onCancel={onClose} onConfirm={() => { void Promise.resolve(onSubmit(environment === "live")).catch(() => undefined); }} />;
}

export function SharedPositionLineTradeDialog({ account, intent, position, instrument, environment, onClose, onSubmit }: { account?: AccountSummary | null; intent: PositionLineTradeIntent; position?: OkxPosition; instrument?: OkxInstrumentSummary; environment: "demo" | "live"; onClose: () => void; onSubmit: (intent: PositionLineTradeIntent, size: string, orderPx: string, confirmedLive: boolean) => void | Promise<void> }) {
  const { t } = useTranslation(["trading", "common"]);
  const max = Math.abs(Number(position?.pos || intent.size || 0));
  const [size, setSize] = useState(normalizeChartSize(max, instrument, { max, enforceMin: false }));
  const supportsClose = intent.kind === "limit_close" || intent.kind === "market_close";
  const [closeMode, setCloseMode] = useState<"limit" | "market">(intent.kind === "market_close" ? "market" : "limit");
  const [orderMode, setOrderMode] = useState<"market" | "limit">("market");
  const [orderPrice, setOrderPrice] = useState(normalizeChartPrice(intent.targetPrice, instrument));
  const [confirming, setConfirming] = useState(false);
  const executionIntent: PositionLineTradeIntent = supportsClose ? { ...intent, kind: closeMode === "market" ? "market_close" : "limit_close" } : intent;
  const submitSize = normalizeChartSize(size, instrument, { max, enforceMin: false });
  const orderPx = executionIntent.kind === "market_close" ? "-1" : executionIntent.kind === "limit_close" ? normalizeChartPrice(intent.targetPrice, instrument) : orderMode === "market" ? "-1" : normalizeChartPrice(orderPrice, instrument);
  const title = executionIntent.kind === "market_close" ? t("trading:marketClosePosition") : executionIntent.kind === "limit_close" ? t("trading:limitCloseAtCurrentPrice") : t("trading:setProtectionPrice");
  const submit = (confirmedLive: boolean) => { void Promise.resolve(onSubmit(executionIntent, submitSize, orderPx, confirmedLive)).catch(() => undefined); };
  return <><Shell title={title} description={`${intent.instId} · ${intent.posSide}`} className="trade-action-modal position-line-trade-modal" onClose={onClose}><div className="position-line-summary"><span>{t("trading:averageEntryPrice")} <b>{fmtPrice(intent.entryPrice)}</b></span><span>{t("trading:currentPrice")} <b>{fmtPrice(intent.currentPrice)}</b></span><span>{t("trading:targetPrice")} <b>{fmtPrice(intent.targetPrice)}</b></span></div><div className="ticket-form modal-trade-form"><label>{t("trading:quantityContracts")}</label><input value={size} onChange={(event) => setSize(event.target.value)} onBlur={() => setSize(submitSize)} />{supportsClose && <><label>{t("trading:positionCloseMode")}</label><div className="segmented-row"><button type="button" className={closeMode === "limit" ? "active" : ""} onClick={() => setCloseMode("limit")}>{t("trading:limitAtCurrentPrice")}</button><button type="button" className={closeMode === "market" ? "active" : ""} onClick={() => setCloseMode("market")}>{t("trading:market")}</button></div></>}{!supportsClose && <><label>{t("trading:strategyOrderPrice")}</label><div className="segmented-row"><button type="button" className={orderMode === "market" ? "active" : ""} onClick={() => setOrderMode("market")}>{t("trading:market")}</button><button type="button" className={orderMode === "limit" ? "active" : ""} onClick={() => setOrderMode("limit")}>{t("trading:limit")}</button></div>{orderMode === "limit" && <input value={orderPrice} onChange={(event) => setOrderPrice(event.target.value)} />}</>}<button type="button" className={clsx("modal-submit", environment === "live" && "danger")} disabled={!account || !submitSize || Number(submitSize) <= 0} onClick={() => environment === "live" ? setConfirming(true) : submit(false)}>{environment === "live" ? t("trading:confirmLiveOperation") : title}</button></div></Shell>{confirming && <Confirm title={t("trading:confirmLiveActionTitle", { action: title })} message={`${intent.instId} · ${submitSize}`} confirmText={t("trading:confirmSubmit")} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); submit(true); }} />}</>;
}
