import { useMemo, useState } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import type { ChartRiskRewardTradeIntent, OkxInstrumentSummary, PrivateAccountSnapshot } from "../types";
import { fmtPrice } from "../lib/format";
import { normalizeChartPrice, normalizeChartSize } from "../lib/chartTradeActions";
import { useDraggableSurface } from "./useDraggableSurface";

export function ChartRiskRewardTradeDialog({ accountId = null, intent, snapshot, instrument, environment, onClose, onSubmit }: {
  accountId?: string | null;
  intent: ChartRiskRewardTradeIntent;
  snapshot: PrivateAccountSnapshot | null;
  instrument?: OkxInstrumentSummary;
  environment: "demo" | "live";
  onClose: () => void;
  onSubmit: (intent: ChartRiskRewardTradeIntent, size: string, marginMode: "cross" | "isolated", lever: string, confirmedLive: boolean) => Promise<void>;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const drag = useDraggableSurface<HTMLElement>();
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [lever, setLever] = useState("20");
  const [size, setSize] = useState(() => normalizeChartSize(instrument?.minSz ?? "", instrument));
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const availableUsdt = Number(snapshot?.balances.find((item) => item.ccy.toUpperCase() === "USDT")?.availEq || snapshot?.balances.find((item) => item.ccy.toUpperCase() === "USDT")?.availBal || 0);
  const ctVal = Number(instrument?.ctVal);
  const maxSize = availableUsdt > 0 && Number(lever) > 0 && ctVal > 0 ? Number(normalizeChartSize(String((availableUsdt * Number(lever)) / (intent.entryPrice * ctVal)), instrument, { enforceMin: false })) || 0 : 0;
  const normalizedSize = normalizeChartSize(size, instrument, { max: maxSize || undefined });
  const entry = normalizeChartPrice(intent.entryPrice, instrument);
  const tp = normalizeChartPrice(intent.takeProfitPrice, instrument);
  const sl = normalizeChartPrice(intent.stopLossPrice, instrument);
  const ratio = useMemo(() => {
    const risk = Math.abs(intent.entryPrice - intent.stopLossPrice);
    return risk > 0 ? Math.abs(intent.takeProfitPrice - intent.entryPrice) / risk : 0;
  }, [intent.entryPrice, intent.stopLossPrice, intent.takeProfitPrice]);
  const submit = async (confirmedLive: boolean) => {
    try {
      await onSubmit(intent, normalizedSize, marginMode, lever, confirmedLive);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setConfirming(false);
    }
  };
  const bracket = intent.action === "bracket";
  const valid = Boolean(accountId && normalizedSize && Number(normalizedSize) > 0 && entry && Number(lever) > 0 && (!bracket || (tp && sl)));
  return <div className="modal-backdrop">
    <section ref={drag.surfaceRef} className="modal-shell trade-action-modal chart-risk-reward-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
      <header className="modal-head" {...drag.handleProps}><div><strong>{bracket ? t("trading:chartOpenWithProtection") : t("trading:chartLimitOpen")}</strong><span>{intent.instId} · {intent.side === "long" ? t("trading:long") : t("trading:short")} · {fmtPrice(intent.entryPrice)}</span></div><button type="button" className="window-button" onClick={onClose}>{t("common:close")}</button></header>
      <div className="position-line-summary chart-risk-reward-summary"><span>{t("trading:entryPrice")} <b>{fmtPrice(intent.entryPrice)}</b></span><span>{t("trading:targetPrice")} <b className="estimate-positive">{fmtPrice(intent.takeProfitPrice)}</b></span><span>{t("trading:stopLoss")} <b className="estimate-negative">{fmtPrice(intent.stopLossPrice)}</b></span><span>{t("trading:riskRewardRatio")} <b>{ratio.toFixed(2)}</b></span></div>
      <div className="ticket-form modal-trade-form"><label>{t("trading:marginMode")}</label><div className="segmented-row"><button type="button" className={clsx(marginMode === "cross" && "active")} onClick={() => setMarginMode("cross")}>{t("trading:cross")}</button><button type="button" className={clsx(marginMode === "isolated" && "active")} onClick={() => setMarginMode("isolated")}>{t("trading:isolated")}</button></div><label>{t("trading:leverage")}</label><input inputMode="decimal" value={lever} onChange={(event) => setLever(event.target.value.replace(/[^0-9.]/g, ""))} /><label>{t("trading:quantityContracts")}</label><input inputMode="decimal" value={size} onChange={(event) => setSize(event.target.value)} onBlur={() => setSize(normalizedSize)} /><small>{t("trading:contractRulesSummary", { minimum: instrument?.minSz || "--", step: instrument?.lotSz || "--", contractValue: instrument?.ctVal || "--", currency: instrument?.ctValCcy || "" })}</small>{error && <p className="detached-trade-status" role="alert">{error}</p>}<button type="button" className={clsx("modal-submit", environment === "live" && "danger")} disabled={!valid} onClick={() => environment === "live" ? setConfirming(true) : void submit(false)}>{environment === "live" ? t("trading:confirmLiveSubmit") : bracket ? t("trading:submitOpenWithProtection") : t("trading:submitLimitOpen")}</button></div>
      {confirming && <div className="modal-backdrop"><section className="modal-shell compact confirm-dialog" role="dialog" aria-modal="true"><header className="modal-head"><strong>{t("trading:confirmLiveChartTradeTitle")}</strong></header><p>{intent.instId} · {normalizedSize} · {entry}{bracket ? ` · TP ${tp} / SL ${sl}` : ""}</p><div className="modal-actions"><button type="button" onClick={() => setConfirming(false)}>{t("common:cancel")}</button><button type="button" className="danger-action" onClick={() => void submit(true)}>{t("trading:confirmSubmit")}</button></div></section></div>}
    </section>
  </div>;
}
