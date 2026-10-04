import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { Calculator, RefreshCw } from "lucide-react";
import { invokeDesktop } from "../../lib/tauri";
import { computeRiskPreview, type RiskFacts, type RiskPreviewRow } from "../../lib/riskPreview";
import "./risk-preview.css";

function money(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value.toFixed(digits)} U`;
}

function contracts(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return String(Number(value.toFixed(4)));
}

function price(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return value >= 1000 ? value.toFixed(1) : value >= 10 ? value.toFixed(2) : value >= 1 ? value.toFixed(3) : value.toPrecision(4);
}

/**
 * Profile 配置页的「按当前账户换算」：把硬风控与保证金上限换成具体金额和张数，提前看出能不能开最小仓位。
 * 账户与行情事实由 `ai_profile_risk_facts` 读取；金额随正在编辑的参数实时重算。只用于展示，不参与风控判定。
 * `previewFacts` 只给预览页用（浏览器里没有桌面命令）。
 */
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
  const { i18n } = useTranslation();
  const chinese = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase().startsWith("zh");
  const tx = useCallback((zh: string, en: string) => (chinese ? zh : en), [chinese]);
  const [facts, setFacts] = useState<RiskFacts | null>(previewFacts ?? null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const symbolKey = symbols.join(",");

  const load = useCallback(async () => {
    if (previewFacts || !accountId) return;
    setLoading(true);
    setFailed(false);
    const result = await invokeDesktop<RiskFacts>("ai_profile_risk_facts", { accountId, symbols: symbolKey ? symbolKey.split(",") : [] }, { quiet: true }).catch(() => null);
    setFacts(result);
    setFailed(!result);
    setLoading(false);
  }, [accountId, previewFacts, symbolKey]);

  useEffect(() => {
    if (previewFacts) return;
    if (!accountId) {
      setFacts(null);
      return;
    }
    // 绑定账户或品种变化后稍等再读，避免逐字输入时连续请求。
    const timer = window.setTimeout(() => void load(), 400);
    return () => window.clearTimeout(timer);
  }, [accountId, load, previewFacts]);

  const preview = useMemo(
    () => (facts ? computeRiskPreview(facts, { riskPerTradePct, dailyLossLimitPct, maxSingleTradeMarginPct, targetLeverage }) : null),
    [dailyLossLimitPct, facts, maxSingleTradeMarginPct, riskPerTradePct, targetLeverage]
  );

  const statusText = (row: RiskPreviewRow) => {
    switch (row.status) {
      case "ok":
        return tx("可以开仓", "Can open");
      case "available_too_low":
        return tx(
          `可用余额不足：最小仓位要 ${money(row.minMargin)} 保证金，可用只有 ${money(preview?.available)}`,
          `Not enough available balance: the minimum size needs ${money(row.minMargin)} margin, only ${money(preview?.available)} available`
        );
      case "margin_cap_too_low":
        return tx(
          `保证金上限太低：最小仓位要 ${money(row.minMargin)}，上限只有 ${money(preview?.marginCapByEquity)}（调高「最大单笔开仓占比」或杠杆）`,
          `Margin cap too low: the minimum size needs ${money(row.minMargin)}, the cap is ${money(preview?.marginCapByEquity)} (raise the max margin per trade or leverage)`
        );
      case "risk_budget_too_small":
        return tx(
          `单笔风险预算太小：最小仓位按 1×ATR 止损要亏 ${money(row.minRisk, 3)}，预算只有 ${money(preview?.riskBudget, 3)}`,
          `Risk budget too small: the minimum size loses ${money(row.minRisk, 3)} at a 1×ATR stop, the budget is ${money(preview?.riskBudget, 3)}`
        );
      default:
        return tx("缺少行情或合约数据", "Market or instrument data unavailable");
    }
  };

  return (
    <div className="risk-preview" data-risk-preview>
      <div className="risk-preview__head">
        <strong><Calculator size={13} />{tx("按当前账户换算", "In money terms for this account")}</strong>
        {facts && facts.equityUsdt !== null ? (
          <span>
            {tx("权益", "Equity")} {money(facts.equityUsdt)} · {tx("可用", "available")} {money(facts.availableUsdt)}
            {facts.snapshotAgeSeconds !== null ? ` · ${tx(`${facts.snapshotAgeSeconds} 秒前`, `${facts.snapshotAgeSeconds}s ago`)}` : ""}
          </span>
        ) : null}
        {!previewFacts && accountId ? (
          <button type="button" onClick={() => void load()} disabled={loading} title={tx("重新读取账户与行情", "Reload account and market data")}>
            <RefreshCw size={12} className={loading ? "spin" : undefined} />
          </button>
        ) : null}
      </div>

      {!accountId ? (
        <p className="risk-preview__note">{tx("绑定账户后，这里会显示具体能亏多少、能开多少张。", "Bind an account to see the amounts and contract counts.")}</p>
      ) : !facts ? (
        <p className="risk-preview__note">{loading ? tx("正在读取账户与行情…", "Loading account and market data…") : failed ? tx("读不到账户或行情数据。", "Account or market data unavailable.") : null}</p>
      ) : facts.accountError || preview?.equity === null ? (
        <p className="risk-preview__note is-warn">{facts.accountError ?? tx("读不到账户权益。", "Account equity unavailable.")}</p>
      ) : preview ? (
        <>
          <div className="risk-preview__chips">
            <span>{tx("单笔最多亏", "Max loss per trade")} <b>{money(preview.riskBudget)}</b>（{riskPerTradePct}%）</span>
            <span>{tx("日亏线", "Daily loss limit")} <b>{money(preview.dailyLimit)}</b>（{dailyLossLimitPct}%）· {tx("今天还能亏", "left today")} <b>{money(preview.dailyRemaining)}</b></span>
            <span>
              {tx("单笔保证金上限", "Max margin per trade")} <b>{money(preview.marginCap)}</b>
              {preview.available !== null && preview.marginCapByEquity !== null && preview.available < preview.marginCapByEquity
                ? tx(`（受可用余额限制；按 ${maxSingleTradeMarginPct}% 本应是 ${money(preview.marginCapByEquity)}）`, ` (limited by available balance; ${maxSingleTradeMarginPct}% would be ${money(preview.marginCapByEquity)})`)
                : `（${maxSingleTradeMarginPct}%）`}
              · {tx("杠杆", "leverage")} {targetLeverage}x
            </span>
          </div>
          {preview.rows.length === 0 ? (
            <p className="risk-preview__note">{tx("还没有选择品种。", "No symbols selected yet.")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{tx("品种", "Symbol")}</th>
                  <th>{tx("最小仓位", "Minimum size")}</th>
                  <th>{tx("按 1×ATR(1h) 止损", "With a 1×ATR(1h) stop")}</th>
                  <th>{tx("最多可开", "Max size")}</th>
                  <th>{tx("状态", "Status")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.instId} className={clsx(row.status !== "ok" && "is-blocked")} data-risk-preview-row={row.status}>
                    <th scope="row">{row.instId.replace("-USDT-SWAP", "")}<small>{price(row.last)}</small></th>
                    <td>
                      {contracts(row.minSize)} {tx("张", "ct")} ≈ {money(row.minNotional, 1)}
                      <small>{tx("保证金", "margin")} {money(row.minMargin)}</small>
                    </td>
                    <td>
                      {tx("距离", "distance")} {price(row.stopDistance)}
                      <small>{tx("每张亏", "per contract")} {money(row.riskPerContract, 3)}（{tx("含费", "incl. fees")}）</small>
                    </td>
                    <td>
                      {row.maxContracts !== null ? (
                        <>
                          {contracts(row.maxContracts)} {tx("张", "ct")}
                          <small>
                            {tx("止损亏", "stop loss")} {money(row.riskAtMax)}（{row.riskPctAtMax?.toFixed(1)}%）· {row.binding === "margin" ? tx("受保证金上限限制", "capped by margin") : tx("受风险预算限制", "capped by risk")}
                          </small>
                        </>
                      ) : "--"}
                    </td>
                    <td className="risk-preview__status">{statusText(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="risk-preview__foot">
            {tx(
              `止损按 1×ATR(1h) 估算，手续费按吃单 ${facts.assumedTakerFeePct}% 来回两次估算；杠杆只影响保证金，不影响止损时亏多少。实际以下单前的预检为准。`,
              `Stops are estimated at 1×ATR(1h) and fees at ${facts.assumedTakerFeePct}% taker both ways; leverage only changes margin, not the loss at the stop. The pre-trade check is authoritative.`
            )}
          </p>
        </>
      ) : null}
    </div>
  );
}
