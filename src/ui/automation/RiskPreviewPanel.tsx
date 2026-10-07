import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { invokeDesktop } from "../../lib/tauri";
import { computeRiskPreview, type RiskFacts, type RiskPreview, type RiskPreviewRow } from "../../lib/riskPreview";
import { HelpTip } from "./ProfileEditorControls";
import "./risk-preview.css";

function money(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value.toFixed(digits)} U`;
}

function plain(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toFixed(digits);
}

function contracts(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return String(Number(value.toFixed(4)));
}

function price(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return value >= 10 ? value.toFixed(2) : value >= 1 ? value.toFixed(3) : value.toPrecision(4);
}

/**
 * 读取「按当前账户换算」需要的事实：绑定账户的权益、可用余额、今日已实现盈亏，以及品种的价格、面值、最小张数、1h ATR。
 * 绑定账户或品种变化后稍等再读，避免逐字输入时连续请求。`previewFacts` 只给预览页用（浏览器里没有桌面命令）。
 */
export function useRiskFacts(accountId: string | null | undefined, symbols: string[], previewFacts?: RiskFacts) {
  const [facts, setFacts] = useState<RiskFacts | null>(previewFacts ?? null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const symbolKey = symbols.join(",");

  const reload = useCallback(async () => {
    if (previewFacts || !accountId) return;
    setLoading(true);
    setFailed(false);
    const result = await invokeDesktop<RiskFacts>("ai_profile_risk_facts", { accountId, symbols: symbolKey ? symbolKey.split(",") : [] }, { quiet: true }).catch(() => null);
    setFacts(result);
    setFailed(!result);
    setLoading(false);
  }, [accountId, previewFacts, symbolKey]);

  useEffect(() => {
    if (previewFacts) {
      setFacts(previewFacts);
      return;
    }
    if (!accountId) {
      setFacts(null);
      return;
    }
    const timer = window.setTimeout(() => void reload(), 400);
    return () => window.clearTimeout(timer);
  }, [accountId, previewFacts, reload]);

  return { facts, loading, failed, reload };
}

/** 开不了最小仓位的行（按最先卡住的那一条说明原因）。 */
export function blockedRiskRows(preview: RiskPreview | null): RiskPreviewRow[] {
  return (preview?.rows ?? []).filter((row) => row.status !== "ok" && row.status !== "no_data");
}

/**
 * Profile 配置页「资金与风险」顶部的换算条：三个关键金额 + 每个品种能不能开、最多开几张，
 * 开不了时只在底部写一行原因。只用于展示，不参与风控判定。
 */
export function RiskPreviewStrip({
  accountId,
  facts,
  preview,
  loading,
  failed,
  maxSingleTradeMarginPct,
  onReload
}: {
  accountId: string | null | undefined;
  facts: RiskFacts | null;
  preview: RiskPreview | null;
  loading: boolean;
  failed: boolean;
  maxSingleTradeMarginPct: number;
  onReload?: () => void;
}) {
  const { i18n } = useTranslation();
  const chinese = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase().startsWith("zh");
  const tx = useCallback((zh: string, en: string) => (chinese ? zh : en), [chinese]);
  const symbolName = (instId: string) => instId.replace(/-USDT-SWAP$/, "");

  const reason = (row: RiskPreviewRow) => {
    const name = symbolName(row.instId);
    switch (row.status) {
      case "available_too_low":
        return tx(`${name}：最小仓位要 ${money(row.minMargin)} 保证金，可用余额只有 ${money(preview?.available)}。`, `${name}: the minimum size needs ${money(row.minMargin)} margin, only ${money(preview?.available)} is available.`);
      case "margin_cap_too_low":
        return tx(`${name}：最小仓位要 ${money(row.minMargin)} 保证金，超过单笔保证金上限 ${money(preview?.marginCapByEquity)}。`, `${name}: the minimum size needs ${money(row.minMargin)} margin, above the per-trade cap of ${money(preview?.marginCapByEquity)}.`);
      case "risk_budget_too_small":
        return tx(`${name}：最小仓位按 1×ATR 止损要亏 ${money(row.minRisk, 3)}，超过单笔最多亏 ${money(preview?.riskBudget, 3)}。`, `${name}: the minimum size loses ${money(row.minRisk, 3)} at a 1×ATR stop, above the per-trade limit of ${money(preview?.riskBudget, 3)}.`);
      default:
        return "";
    }
  };

  const blocked = blockedRiskRows(preview);
  const limitedByAvailable = preview?.available !== null && preview?.available !== undefined && preview.marginCapByEquity !== null && preview.available < preview.marginCapByEquity;
  const assumption = tx(
    `止损按 1×ATR(1h) 估算（交易手册要求至少这么远），手续费按吃单 ${facts?.assumedTakerFeePct ?? 0.05}% 来回两次估算；杠杆只影响保证金，不影响打到止损时亏多少。实际以下单前的预检为准。`,
    `Stops are estimated at 1×ATR(1h) and fees at ${facts?.assumedTakerFeePct ?? 0.05}% taker both ways; leverage only changes margin, not the loss at the stop. The pre-trade check is authoritative.`
  );

  return (
    <div className="risk-strip" data-risk-preview>
      <div className="risk-strip__head">
        <span>{tx("按当前账户换算", "In money terms for this account")}</span>
        <HelpTip text={assumption} />
        {facts && facts.equityUsdt !== null ? (
          <span className="risk-strip__meta">
            {tx("权益", "Equity")} {plain(facts.equityUsdt)} · {tx("可用", "available")} {plain(facts.availableUsdt)}
            {facts.snapshotAgeSeconds !== null ? ` · ${tx(`${facts.snapshotAgeSeconds} 秒前`, `${facts.snapshotAgeSeconds}s ago`)}` : ""}
          </span>
        ) : <span className="risk-strip__meta" />}
        {onReload && accountId ? (
          <button type="button" onClick={onReload} disabled={loading} title={tx("重新读取账户与行情", "Reload account and market data")} aria-label={tx("重新读取账户与行情", "Reload account and market data")}>
            <RefreshCw size={12} className={loading ? "spin" : undefined} />
          </button>
        ) : null}
      </div>

      {!accountId ? (
        <p className="risk-strip__note">{tx("绑定账户后，这里会显示具体能亏多少、能开多少张。", "Bind an account to see the amounts and contract counts.")}</p>
      ) : !facts ? (
        <p className="risk-strip__note">{loading ? tx("正在读取账户与行情…", "Loading account and market data…") : failed ? tx("读不到账户或行情数据。", "Account or market data unavailable.") : " "}</p>
      ) : facts.accountError || preview?.equity === null ? (
        <p className="risk-strip__note is-warn">{facts.accountError ?? tx("读不到账户权益。", "Account equity unavailable.")}</p>
      ) : preview ? (
        <>
          <div className="risk-strip__body">
            <div className="risk-strip__kpis">
              <div><small>{tx("单笔最多亏", "Max loss per trade")}</small><strong>{money(preview.riskBudget)}</strong></div>
              <div><small>{tx("今天还能亏", "Loss left today")}</small><strong>{money(preview.dailyRemaining)}</strong></div>
              <div>
                <small>{tx("单笔保证金最多", "Max margin per trade")}</small>
                <strong
                  className={clsx(limitedByAvailable && "is-warn")}
                  title={limitedByAvailable ? tx(`受可用余额限制；按 ${maxSingleTradeMarginPct}% 本应是 ${money(preview.marginCapByEquity)}`, `Limited by available balance; ${maxSingleTradeMarginPct}% would be ${money(preview.marginCapByEquity)}`) : undefined}
                >
                  {money(preview.marginCap)}
                </strong>
              </div>
            </div>
            <span className="risk-strip__divider" aria-hidden="true" />
            {preview.rows.length === 0 ? (
              <p className="risk-strip__note">{tx("还没有选择品种。", "No symbols selected yet.")}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{tx("品种", "Symbol")}</th>
                    <th>{tx("最小仓位保证金", "Min-size margin")}</th>
                    <th>{tx("最多可开", "Max size")}</th>
                    <th aria-label={tx("状态", "Status")} />
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.instId} className={clsx(row.status !== "ok" && "is-blocked")} data-risk-preview-row={row.status}>
                      <th scope="row">{symbolName(row.instId)}<small>{price(row.last)}</small></th>
                      <td>{money(row.minMargin)}</td>
                      <td
                        title={row.maxContracts !== null
                          ? tx(
                            `开满时打到止损约亏 ${money(row.riskAtMax)}（权益的 ${row.riskPctAtMax?.toFixed(1)}%）；${row.binding === "margin" ? "被保证金上限卡住" : "被单笔最多亏卡住"}`,
                            `At full size the stop loses about ${money(row.riskAtMax)} (${row.riskPctAtMax?.toFixed(1)}% of equity); capped by ${row.binding === "margin" ? "margin" : "risk"}`
                          )
                          : undefined}
                      >
                        {row.maxContracts !== null ? `${contracts(row.maxContracts)} ${tx("张", "ct")}` : "—"}
                      </td>
                      <td>
                        <span className={clsx("risk-strip__state", row.status === "ok" ? "is-ok" : row.status === "no_data" ? "is-unknown" : "is-bad")}>
                          {row.status === "ok" ? tx("可开", "Can open") : row.status === "no_data" ? tx("无数据", "No data") : tx("开不了", "Too small")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {blocked.length > 0 ? (
            <div className="risk-strip__why"><AlertTriangle size={13} aria-hidden="true" /><span>{blocked.map(reason).join(" ")}</span></div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 独立使用的换算面板（预览页夹具用）：自己读取事实，再按传入的参数换算。 */
export function RiskPreviewPanel({
  accountId,
  symbols,
  riskPerTradePct,
  dailyLossLimitPct,
  maxSingleTradeMarginPct,
  targetLeverage,
  previewFacts
}: {
  accountId: string | null | undefined;
  symbols: string[];
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  maxSingleTradeMarginPct: number;
  targetLeverage: number;
  previewFacts?: RiskFacts;
}) {
  const { facts, loading, failed, reload } = useRiskFacts(accountId, symbols, previewFacts);
  const preview = useMemo(
    () => (facts ? computeRiskPreview(facts, { riskPerTradePct, dailyLossLimitPct, maxSingleTradeMarginPct, targetLeverage }) : null),
    [dailyLossLimitPct, facts, maxSingleTradeMarginPct, riskPerTradePct, targetLeverage]
  );
  return (
    <RiskPreviewStrip
      accountId={accountId}
      facts={facts}
      preview={preview}
      loading={loading}
      failed={failed}
      maxSingleTradeMarginPct={maxSingleTradeMarginPct}
      onReload={previewFacts ? undefined : () => void reload()}
    />
  );
}
