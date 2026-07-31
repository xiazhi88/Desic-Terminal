import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OkxInstrumentSummary, PrivateAccountSnapshot } from "../types";
import { placeOkxOrder } from "../lib/okx";
import type { ChartContextTradeIntent } from "./KlineChart";
import { createTradeExecutionKey } from "./trade-ticket/model";
import { useDraggableSurface } from "./useDraggableSurface";

type Props = {
  draft: ChartContextTradeIntent;
  accountId: string | null | undefined;
  environment: "demo" | "live";
  instrument?: OkxInstrumentSummary;
  accountSnapshot?: PrivateAccountSnapshot | null;
  accountTradeConfig?: ChartQuickTradeAccountConfig | null;
  onClose: () => void;
  onSubmitted: () => void;
};

export type ChartQuickTradeAccountConfig = Readonly<{
  accountId: string | null;
  environment: "demo" | "live";
  symbol: string;
  marginMode: "cross" | "isolated";
  leverage: string;
}>;

function accountTradeConfigStorageKey(accountId: string | null | undefined, environment: "demo" | "live", symbol: string) {
  return `desic.chart-trade-config.v1:${accountId ?? "default"}:${environment}:${symbol}`;
}

function loadStoredAccountTradeConfig(accountId: string | null | undefined, environment: "demo" | "live", symbol: string) {
  try {
    const raw = window.localStorage.getItem(accountTradeConfigStorageKey(accountId, environment, symbol));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChartQuickTradeAccountConfig;
    return parsed.accountId === (accountId ?? null) && parsed.environment === environment && parsed.symbol === symbol
      && (parsed.marginMode === "cross" || parsed.marginMode === "isolated") && Number(parsed.leverage) > 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function persistChartQuickTradeAccountConfig(config: ChartQuickTradeAccountConfig) {
  try {
    window.localStorage.setItem(accountTradeConfigStorageKey(config.accountId, config.environment, config.symbol), JSON.stringify(config));
  } catch {
    // Storage is only a desktop convenience cache. The order submit path remains authoritative.
  }
}

function decimalPlacesFromStep(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  if (text.includes("e-")) {
    const [, exponent] = text.split("e-");
    return Math.min(12, Number(exponent) || 0);
  }
  return Math.max(0, Math.min(12, (text.split(".")[1] ?? "").length));
}

function normalizeQuantity(value: number, instrument?: OkxInstrumentSummary) {
  const minimum = Number(instrument?.minSz) || 0;
  const step = Number(instrument?.lotSz) || minimum || 1;
  if (!Number.isFinite(value) || value <= 0) return "";
  const rounded = Math.floor((value + step * 1e-7) / step) * step;
  const normalized = Math.max(minimum, rounded);
  const decimals = decimalPlacesFromStep(step);
  return normalized.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function normalizePrice(value: number, instrument?: OkxInstrumentSummary) {
  const step = Number(instrument?.tickSz) || 0;
  if (!Number.isFinite(value) || value <= 0) return "";
  if (!Number.isFinite(step) || step <= 0) return String(value);
  const rounded = Math.floor((value + step * 1e-7) / step) * step;
  const decimals = decimalPlacesFromStep(step);
  return rounded.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatNumber(value: number | null | undefined, digits = 3) {
  return Number.isFinite(value) ? value!.toFixed(digits) : "--";
}

function actionTone(action: ChartContextTradeIntent["action"]) {
  return action === "long" || action === "close-short" ? "long" : "short";
}

function availableUsdtFromSnapshot(snapshot?: PrivateAccountSnapshot | null) {
  const balance = snapshot?.balances.find((item) => item.ccy.toUpperCase() === "USDT");
  for (const value of [balance?.availEq, balance?.availBal, balance?.cashBal]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
}

function availablePositionFromSnapshot(snapshot: PrivateAccountSnapshot | null | undefined, symbol: string, side: "long" | "short") {
  const total = snapshot?.positions
    .filter((item) => item.instId === symbol && item.posSide.toLowerCase() === side)
    .reduce((sum, item) => {
      const quantity = Number(item.pos);
      return Number.isFinite(quantity) && quantity > 0 ? sum + quantity : sum;
    }, 0) ?? 0;
  return total > 0 ? total : null;
}

export function ChartQuickTradeDialog({ draft, accountId, environment, instrument, accountSnapshot, accountTradeConfig, onClose, onSubmitted }: Props) {
  const { t } = useTranslation(["trading", "chart", "common"]);
  const dialogDrag = useDraggableSurface<HTMLElement>();
  const confirmDrag = useDraggableSurface<HTMLElement>();
  const matchingPosition = useMemo(
    () => accountSnapshot?.positions.find((item) => item.instId === draft.symbol && Number(item.pos) > 0) ?? null,
    [accountSnapshot?.positions, draft.symbol],
  );
  const storedAccountConfig = useMemo(
    () => loadStoredAccountTradeConfig(accountId, environment, draft.symbol),
    [accountId, draft.symbol, environment],
  );
  const activeAccountConfig = accountTradeConfig?.accountId === (accountId ?? null) && accountTradeConfig.environment === environment && accountTradeConfig.symbol === draft.symbol
    ? accountTradeConfig
    : storedAccountConfig;
  const marginMode = activeAccountConfig?.marginMode ?? (matchingPosition?.mgnMode === "isolated" ? "isolated" : "cross");
  const leverage = activeAccountConfig?.leverage || matchingPosition?.lever || instrument?.lever || "20";
  const [percent, setPercent] = useState(25);
  const [size, setSize] = useState(instrument?.minSz || "");
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState<{ size: string; price: string } | null>(null);
  const isClosing = draft.action === "close-long" || draft.action === "close-short";
  const actionText = draft.action === "long"
    ? t("trading:long")
    : draft.action === "short"
      ? t("trading:short")
      : draft.action === "close-long"
        ? t("trading:closeLong")
        : t("trading:closeShort");
  const ticketMode = isClosing ? "close" : "open";
  const snapshotAvailableUsdt = useMemo(() => availableUsdtFromSnapshot(accountSnapshot), [accountSnapshot]);
  const snapshotCloseLimit = useMemo(
    () => availablePositionFromSnapshot(accountSnapshot, draft.symbol, draft.action === "close-long" ? "long" : "short"),
    [accountSnapshot, draft.action, draft.symbol],
  );
  const estimatedOpenLimit = useMemo(() => {
    if (isClosing || !snapshotAvailableUsdt) return null;
    const contractValue = Number(instrument?.ctVal);
    const leverageValue = Number(leverage);
    if (!Number.isFinite(contractValue) || contractValue <= 0 || !Number.isFinite(leverageValue) || leverageValue <= 0 || !Number.isFinite(draft.price) || draft.price <= 0) return null;
    return (snapshotAvailableUsdt * leverageValue) / (draft.price * contractValue);
  }, [draft.price, instrument?.ctVal, isClosing, leverage, snapshotAvailableUsdt]);
  const localLimit = isClosing ? snapshotCloseLimit : estimatedOpenLimit;
  const availableLimit = Number.isFinite(localLimit) && localLimit! > 0 ? localLimit! : null;
  const normalizedPrice = normalizePrice(draft.price, instrument);
  const displayPrice = draft.orderType === "market" ? t("trading:market") : `${normalizedPrice || draft.price.toFixed(3)} USDT`;
  const selectedSize = Number(size);
  const normalizedSizeForDisplay = normalizeQuantity(selectedSize, instrument);
  const contractValue = Number(instrument?.ctVal);
  const leverageValue = Number(leverage);
  const selectedNotional = Number.isFinite(selectedSize) && selectedSize > 0 && Number.isFinite(contractValue) && contractValue > 0 && Number.isFinite(draft.price) && draft.price > 0
    ? selectedSize * contractValue * draft.price
    : null;
  const estimatedMargin = !isClosing && Number.isFinite(selectedNotional) && Number.isFinite(leverageValue) && leverageValue > 0
    ? selectedNotional! / leverageValue
    : null;
  const estimatedFee = Number.isFinite(selectedNotional)
    ? selectedNotional! * (draft.orderType === "market" ? 0.0005 : 0.0002)
    : null;
  const normalizedDiffers = normalizedSizeForDisplay && size.trim() !== normalizedSizeForDisplay;
  const closeSizeExceeded = isClosing && availableLimit !== null && Number.isFinite(selectedSize) && selectedSize > availableLimit + 1e-9;
  const invalidSize = !normalizedSizeForDisplay || !Number.isFinite(selectedSize) || selectedSize <= 0;
  const missingClosePosition = isClosing && !availableLimit;
  const localBlocker = invalidSize
    ? t("trading:invalidContractQuantity")
    : closeSizeExceeded
      ? t("trading:exceedsClosableQuantity")
      : missingClosePosition
        ? draft.action === "close-long" ? t("trading:noLongPositionToClose") : t("trading:noShortPositionToClose")
        : "";

  useEffect(() => {
    if (accountTradeConfig?.accountId !== (accountId ?? null) || accountTradeConfig.environment !== environment || accountTradeConfig.symbol !== draft.symbol) return;
    persistChartQuickTradeAccountConfig(accountTradeConfig);
  }, [accountId, accountTradeConfig, draft.symbol, environment]);

  useEffect(() => {
    if (!availableLimit) return;
    setSize(normalizeQuantity((availableLimit * percent) / 100, instrument));
  }, [availableLimit, instrument, percent]);

  const submitOrder = async (normalizedSize: string, price: string, confirmedLive: boolean) => {
    if (!accountId || submitting) return;
    setSubmitting(true);
    setStatus(t("trading:submittingToOkx"));
    try {
      await placeOkxOrder({
        accountId,
        instId: draft.symbol,
        tdMode: marginMode,
        orderType: draft.orderType,
        ticketMode,
        action: draft.action,
        price,
        size: normalizedSize,
        lever: leverage,
        environment,
        confirmedLive,
        operator: "user",
        executionKey: createTradeExecutionKey(accountId, environment, draft.symbol),
      });
      setLiveConfirm(null);
      onSubmitted();
    } catch (error) {
      setLiveConfirm(null);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async () => {
    if (!accountId || submitting) return;
    const normalizedSize = normalizeQuantity(Number(size), instrument);
    if (localBlocker || !normalizedSize) {
      setStatus(localBlocker || t("trading:invalidContractQuantity"));
      return;
    }
    const price = draft.orderType === "market" ? String(draft.price) : normalizedPrice || String(draft.price);
    if (environment === "live") {
      setLiveConfirm({ size: normalizedSize, price });
      return;
    }
    await submitOrder(normalizedSize, price, false);
  };

  return <div className="detached-trade-backdrop" role="presentation" onMouseDown={onClose}>
    <section ref={dialogDrag.surfaceRef} className="detached-trade-dialog chart-quick-trade-dialog" role="dialog" aria-modal="true" aria-label={t("chart:quickTrade")} onMouseDown={(event) => event.stopPropagation()}>
      <header {...dialogDrag.handleProps}><div><strong>{draft.orderType === "market" ? t("trading:market") : t("trading:limit")} · {actionText}</strong><span>{draft.symbol} · {displayPrice}</span></div><button type="button" onClick={onClose}>{t("common:close")}</button></header>
      <div className="chart-quick-trade-account-config" aria-label={t("trading:currentTradingConfiguration")}>
        <span>{t("trading:accountConfiguration")}</span><strong>{marginMode === "isolated" ? t("trading:isolated") : t("trading:cross")} · {leverage}X</strong>
      </div>
      <label>{t("trading:quantityContracts")}<input value={size} inputMode="decimal" onChange={(event) => setSize(event.target.value)} /></label>
      <label className="detached-trade-percent">{isClosing ? t("trading:closeRatio") : t("trading:openRatio")}<output>{percent}%</output><input type="range" min="1" max="100" value={percent} onChange={(event) => setPercent(Number(event.target.value))} /></label>
      <small>{availableLimit
        ? t(isClosing ? "trading:currentClosableSize" : "trading:currentOpenEstimate", { size: normalizeQuantity(availableLimit, instrument) })
        : t(isClosing ? "trading:noClosablePosition" : "trading:waitingAccountBalance")}
        {" · "}{t("trading:contractRulesSummary", {
          minimum: instrument?.minSz || "--",
          step: instrument?.lotSz || "--",
          contractValue: instrument?.ctVal || "--",
          currency: instrument?.ctValCcy || "",
        })}</small>
      <div className="chart-quick-trade-estimate">
        <span>{t("trading:availableAmount", { value: formatNumber(snapshotAvailableUsdt) })}</span>
        <span>{t("trading:notionalValueAmount", { value: formatNumber(selectedNotional) })}</span>
        <span>{t("trading:estimatedMarginAmount", { value: formatNumber(estimatedMargin) })}</span>
        <span>{t("trading:estimatedFeeAmount", { value: formatNumber(estimatedFee) })}</span>
        <span>{t("trading:normalizedQuantityAmount", { value: normalizedSizeForDisplay || "--" })}</span>
        <span>{draft.orderType === "market" ? t("trading:submitAtMarket") : t("trading:orderPriceAmount", { value: normalizedPrice || "--" })}</span>
      </div>
      {normalizedDiffers && <p className="detached-trade-hint">{t("trading:normalizedQuantityHint", { size: normalizedSizeForDisplay })}</p>}
      {status && <p className="detached-trade-status">{status}</p>}
      <footer><button type="button" onClick={onClose}>{t("common:cancel")}</button><button type="button" className={actionTone(draft.action)} disabled={submitting || !accountId || !!localBlocker} onClick={() => void submit()}>{submitting ? t("trading:submitting") : t("trading:confirmSubmit")}</button></footer>
    </section>
    {liveConfirm && (
      <div className="detached-trade-backdrop nested" role="presentation" onMouseDown={(event) => {
        event.stopPropagation();
        setLiveConfirm(null);
      }}>
        <section ref={confirmDrag.surfaceRef} className="detached-trade-dialog compact chart-live-confirm-dialog" role="dialog" aria-modal="true" aria-label={t("trading:liveSecondConfirmation")} onMouseDown={(event) => event.stopPropagation()}>
          <header {...confirmDrag.handleProps}>
            <div><strong>{t("trading:liveSecondConfirmation")}</strong><span>{t("trading:liveConfirmationDescription")}</span></div>
            <button type="button" onClick={() => setLiveConfirm(null)}>{t("common:close")}</button>
          </header>
          <p className="chart-live-confirm-copy">
            {draft.orderType === "limit"
              ? t("trading:liveLimitConfirmationQuestion", { action: actionText, symbol: draft.symbol, size: liveConfirm.size, price: liveConfirm.price })
              : t("trading:liveMarketConfirmationQuestion", { action: actionText, symbol: draft.symbol, size: liveConfirm.size })}
          </p>
          <footer>
            <button type="button" onClick={() => setLiveConfirm(null)}>{t("trading:recheck")}</button>
            <button type="button" className={actionTone(draft.action)} disabled={submitting} onClick={() => void submitOrder(liveConfirm.size, liveConfirm.price, true)}>
              {submitting ? t("trading:submitting") : t("trading:confirmLiveSubmit")}
            </button>
          </footer>
        </section>
      </div>
    )}
  </div>;
}
