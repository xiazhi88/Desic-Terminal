import { useEffect, useState } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { loadAiAutomationModeComparison, type AiAutomationModeComparisonRow } from "../../lib/ai";
import "./mode-comparison.css";

const DAY_MS = 86_400_000;

/** 夹具预览页（`/automation-preview`）没有桌面命令：用一组示例数字展示这张表。 */
const PREVIEW_ROWS: AiAutomationModeComparisonRow[] = [
  { mode: "tools", runs: 42, failedRuns: 3, medianInputTokens: 2_071_207, medianTotalTokens: 2_118_000, medianDurationMs: 225_000, opportunitiesCreated: 9, opportunitiesExecuted: 4, closedTrades: 3, netPnl: -1.42 },
  { mode: "briefing", runs: 38, failedRuns: 1, medianInputTokens: 186_000, medianTotalTokens: 201_500, medianDurationMs: 48_000, opportunitiesCreated: 6, opportunitiesExecuted: 3, closedTrades: 2, netPnl: 0.86 }
];
const RANGES = [7, 30] as const;

function formatTokens(value: number | null) {
  if (value === null) return "--";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatDuration(ms: number | null, chinese: boolean) {
  if (ms === null) return "--";
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (chinese) return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

/**
 * 经典模式与交易员模式的对比：只在出现过交易员模式的运行时显示。
 * `previewRows` 只给预览页用（浏览器里没有桌面命令）。
 */
export function ModeComparison({ refreshKey, previewRows }: { refreshKey?: unknown; previewRows?: AiAutomationModeComparisonRow[] }) {
  const { t, i18n } = useTranslation("automation");
  const chinese = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase().startsWith("zh");
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  previewRows ??= typeof window !== "undefined" && window.location.pathname === "/automation-preview" ? PREVIEW_ROWS : undefined;
  const [rows, setRows] = useState<AiAutomationModeComparisonRow[] | null>(previewRows ?? null);

  useEffect(() => {
    if (previewRows) {
      setRows(previewRows);
      return;
    }
    let cancelled = false;
    const now = Date.now();
    // 统计失败只影响这张对比表：不显示，也不向上抛（否则会变成未处理的 promise 拒绝）。
    loadAiAutomationModeComparison(now - days * DAY_MS, now)
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch(() => {
        if (!cancelled) setRows(null);
      });
    return () => {
      cancelled = true;
    };
  }, [days, refreshKey, previewRows]);

  if (!rows || !rows.some((row) => row.mode === "briefing")) return null;
  const ordered = [...rows].sort((left, right) => (left.mode === "tools" ? -1 : 1) - (right.mode === "tools" ? -1 : 1));

  return (
    <section className="mode-compare" data-mode-comparison>
      <header>
        <strong>{t("runModeComparison")}</strong>
        <span>{t("runModeComparisonNote")}</span>
        <div className="automation-segmented compact" role="tablist">
          {RANGES.map((value) => (
            <button type="button" role="tab" key={value} aria-selected={days === value} className={days === value ? "active" : ""} onClick={() => setDays(value)}>
              {t("runModeDays", { count: value })}
            </button>
          ))}
        </div>
      </header>
      <table>
        <thead>
          <tr>
            <th />
            <th>{t("runModeRuns")}</th>
            <th>{t("runModeTokens")}</th>
            <th>{t("runModeDuration")}</th>
            <th>{t("runModeOpportunities")}</th>
            <th>{t("runModeClosed")}</th>
            <th>{t("runModePnl")}</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => (
            <tr key={row.mode} className={clsx(row.mode === "briefing" && "is-trader")} data-mode-row={row.mode}>
              <th scope="row">{row.mode === "briefing" ? t("profileContextModeBriefing") : t("profileContextModeTools")}</th>
              <td>
                {row.runs}
                {row.failedRuns > 0 ? <small>{` · ${t("runModeFailed")} ${row.failedRuns}`}</small> : null}
              </td>
              <td>{formatTokens(row.medianTotalTokens)}</td>
              <td>{formatDuration(row.medianDurationMs, chinese)}</td>
              <td>{`${row.opportunitiesCreated} / ${row.opportunitiesExecuted}`}</td>
              <td>{row.closedTrades}</td>
              <td className={clsx(row.netPnl !== null && (row.netPnl >= 0 ? "is-up" : "is-down"))}>
                {row.netPnl === null ? "--" : `${row.netPnl >= 0 ? "+" : ""}${row.netPnl.toFixed(2)} U`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
