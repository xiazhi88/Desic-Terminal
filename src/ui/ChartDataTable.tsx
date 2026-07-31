import { Download, TableProperties } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { calculateIndicator, INDICATOR_DEFINITIONS, type IndicatorInstance, type IndicatorSeries } from "../lib/chartIndicators";
import { loadChartWorkspace } from "../lib/okx";
import { resolveChartTradeAction } from "../lib/chartTradeSemantics";
import { logger } from "../lib/logger";
import { invokeDesktop, isTauriRuntime } from "../lib/tauri";
import { formatLocalizedDate, formatLocalizedNumber } from "../i18n/runtime";
import type { Candle, ChartCsvExportResult, ChartFillMarker, ChartOrderLine, TradeOpportunity } from "../types";

type ChartDataTableProps = {
  symbol: string;
  timeframe: string;
  candles: readonly Candle[];
  fills: readonly ChartFillMarker[];
  opportunities: readonly TradeOpportunity[];
  orderLines: readonly ChartOrderLine[];
  workspaceId?: string;
};

type IndicatorColumn = {
  key: string;
  label: string;
  values: Map<number, number>;
};

type ExportHint =
  | { kind: "opening" }
  | { kind: "cancelled" }
  | { kind: "saved"; path: string }
  | { kind: "exported"; filename: string }
  | { kind: "error"; message?: string };

const DEFAULT_INDICATORS: readonly IndicatorInstance[] = [
  { id: "builtin-ma5", definitionId: "ma", paneId: "main", visible: true, parameters: { period: 5 } },
  { id: "builtin-ma10", definitionId: "ma", paneId: "main", visible: true, parameters: { period: 10 } }
];

function parseWorkspaceIndicators(value: unknown): IndicatorInstance[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { instances?: unknown }).instances)) return [];
  const known = new Set(Object.keys(INDICATOR_DEFINITIONS));
  return (value as { instances: unknown[] }).instances.flatMap((item): IndicatorInstance[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<IndicatorInstance>;
    if (
      typeof source.id !== "string"
      || typeof source.paneId !== "string"
      || typeof source.visible !== "boolean"
      || typeof source.definitionId !== "string"
      || !known.has(source.definitionId)
    ) return [];
    return [{
      id: source.id,
      definitionId: source.definitionId as IndicatorInstance["definitionId"],
      paneId: source.paneId,
      visible: source.visible,
      parameters: source.parameters && typeof source.parameters === "object" ? { ...source.parameters } : {}
    }];
  });
}

function formatNumber(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const maximumFractionDigits = Math.abs(numeric) >= 1000 ? 2 : Math.abs(numeric) >= 1 ? 5 : 8;
  return formatLocalizedNumber(numeric, { maximumFractionDigits });
}

function tradeActionLabel(t: TFunction, action: ReturnType<typeof resolveChartTradeAction>) {
  if (action === "open-long") return t("trading:openLong");
  if (action === "open-short") return t("trading:openShort");
  if (action === "close-long") return t("trading:closeLong");
  if (action === "close-short") return t("trading:closeShort");
  return t("trading:trade");
}

function opportunityStatusLabel(t: TFunction, status: TradeOpportunity["status"]) {
  switch (status) {
    case "pending": return t("chart:opportunityPending");
    case "approved": return t("chart:opportunityApproved");
    case "executing": return t("chart:opportunityExecuting");
    case "submitted": return t("chart:opportunitySubmitted");
    case "partially_filled": return t("chart:opportunityPartiallyFilled");
    case "executed": return t("chart:opportunityExecuted");
    case "closed": return t("chart:opportunityClosed");
    case "rejected": return t("chart:opportunityRejected");
    case "failed": return t("chart:opportunityFailed");
    case "cancelled": return t("chart:opportunityCancelled");
    case "expired": return t("chart:opportunityExpired");
    case "pending_blocked": return t("chart:opportunityPendingBlocked");
    case "recovery_blocked": return t("chart:opportunityRecoveryBlocked");
  }
}

function formatTime(time: number) {
  return formatLocalizedDate(new Date(time * 1000), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function nearestCandleTime(candles: readonly Candle[], input: number) {
  if (!Number.isFinite(input) || candles.length === 0) return null;
  let nearest = candles[0];
  let difference = Math.abs(nearest.time - input);
  for (const candle of candles.slice(1)) {
    const nextDifference = Math.abs(candle.time - input);
    if (nextDifference < difference) {
      nearest = candle;
      difference = nextDifference;
    }
  }
  return nearest.time;
}

function normalizedOpportunityTime(value: number) {
  return value >= 100_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function indicatorColumns(instances: readonly IndicatorInstance[], candles: readonly Candle[]): IndicatorColumn[] {
  return instances
    .filter((item) => item.visible)
    .flatMap((instance) => {
      const result = calculateIndicator(instance, { candles });
      if (result.status !== "ready") return [];
      const definition = INDICATOR_DEFINITIONS[instance.definitionId];
      const suffix = Object.values(instance.parameters ?? {}).length
        ? `(${Object.values(instance.parameters ?? {}).join(",")})`
        : "";
      return result.series.map((series: IndicatorSeries) => ({
        key: `${instance.id}:${series.key}`,
        label: `${definition.name}${suffix} · ${series.label}`,
        values: new Map(series.points.map((point) => [point.time, point.value]))
      }));
    });
}

function cellForCsv(value: string | number) {
  const text = String(value).replace(/\r?\n/g, " ");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function ChartDataTable({ symbol, timeframe, candles, fills, opportunities, orderLines, workspaceId = "main-chart" }: ChartDataTableProps) {
  const { t } = useTranslation(["chart", "trading", "common"]);
  const [instances, setInstances] = useState<IndicatorInstance[]>(() => [...DEFAULT_INDICATORS]);
  const [exportState, setExportState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [exportHint, setExportHint] = useState<ExportHint | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadChartWorkspace(workspaceId).then((workspace) => {
      if (cancelled || !workspace) return;
      const parsed = parseWorkspaceIndicators(workspace.indicators);
      if (parsed.length > 0) setInstances(parsed);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [workspaceId]);

  const columns = useMemo(() => indicatorColumns(instances, candles), [candles, instances]);
  const labelsByTime = useMemo(() => {
    const labels = new Map<number, string[]>();
    const add = (time: number | null, label: string) => {
      if (time === null) return;
      labels.set(time, [...(labels.get(time) ?? []), label]);
    };
    for (const fill of fills) {
      add(nearestCandleTime(candles, fill.time), t("chart:fillEvent", {
        action: tradeActionLabel(t, resolveChartTradeAction(fill)),
        quantity: fill.size ? ` · ${t("chart:contractQuantity", { size: fill.size })}` : ""
      }));
    }
    for (const opportunity of opportunities) {
      if (opportunity.instId !== symbol) continue;
      const size = opportunity.newSize || opportunity.size;
      add(
        nearestCandleTime(candles, normalizedOpportunityTime(opportunity.createdAt)),
        t("chart:opportunityEvent", {
          action: tradeActionLabel(t, resolveChartTradeAction(opportunity)),
          quantity: size ? ` · ${t("chart:contractQuantity", { size })}` : "",
          status: opportunityStatusLabel(t, opportunity.status)
        })
      );
    }
    const latest = candles.at(-1)?.time ?? null;
    for (const orderLine of orderLines) {
      add(latest, t("chart:orderEvent", { label: orderLine.label, price: formatNumber(orderLine.price) }));
    }
    return labels;
  }, [candles, fills, opportunities, orderLines, symbol, t]);
  const rows = useMemo(() => [...candles].reverse(), [candles]);

  const exportCsv = async () => {
    const headers = [
      t("common:time"),
      t("trading:open"),
      t("trading:high"),
      t("trading:low"),
      t("trading:close"),
      t("trading:volume"),
      ...columns.map((column) => column.label),
      t("chart:labels")
    ];
    const data = rows.map((candle) => [
      formatTime(candle.time),
      formatNumber(candle.open),
      formatNumber(candle.high),
      formatNumber(candle.low),
      formatNumber(candle.close),
      formatNumber(candle.volume),
      ...columns.map((column) => formatNumber(column.values.get(candle.time))),
      (labelsByTime.get(candle.time) ?? []).join(" | ")
    ]);
    const content = [headers, ...data].map((row) => row.map(cellForCsv).join(",")).join("\n");
    const suggestedName = `${symbol}-${timeframe}-kline.csv`;
    if (isTauriRuntime()) {
      setExportState("saving");
      setExportHint({ kind: "opening" });
      try {
        const result = await invokeDesktop<ChartCsvExportResult | null>("export_chart_csv", { suggestedName, contents: content });
        if (!result) {
          setExportState("idle");
          setExportHint({ kind: "cancelled" });
          return;
        }
        setExportState("saved");
        setExportHint({ kind: "saved", path: result.path });
      } catch (error) {
        logger.error("chart csv export failed", error, { symbol, timeframe });
        setExportState("error");
        setExportHint({ kind: "error", message: error instanceof Error ? error.message : undefined });
      }
      return;
    }
    const blob = new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = suggestedName;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    window.setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(href);
    }, 1_000);
    setExportState("saved");
    setExportHint({ kind: "exported", filename: suggestedName });
  };

  const exportHintText = exportHint?.kind === "opening"
    ? t("chart:openingSaveLocation")
    : exportHint?.kind === "cancelled"
      ? t("chart:exportCancelled")
      : exportHint?.kind === "saved"
        ? t("chart:savedTo", { path: exportHint.path })
        : exportHint?.kind === "exported"
          ? t("chart:exportedFile", { filename: exportHint.filename })
          : exportHint?.kind === "error"
            ? exportHint.message || t("chart:exportFailed")
            : "";

  return (
    <section className="chart-data-table" aria-label={t("chart:dataTableAria")}>
      <header className="chart-data-table-header">
        <div>
          <TableProperties size={15} aria-hidden="true" />
          <strong>{t("chart:dataTableTitle")}</strong>
          <span>{symbol} · {timeframe} · {t("chart:candleCount", { count: candles.length })}</span>
        </div>
        <div className="chart-data-table-export">
          {exportHintText ? <small className={exportState}>{exportHintText}</small> : null}
          <button type="button" onClick={() => void exportCsv()} disabled={rows.length === 0 || exportState === "saving"} title={t("chart:exportCsvTitle")}>
            <Download size={14} /> {exportState === "saving" ? t("chart:saving") : t("chart:exportTable")}
          </button>
        </div>
      </header>
      <div className="chart-data-table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("common:time")}</th>
              <th>{t("trading:open")}</th>
              <th>{t("trading:high")}</th>
              <th>{t("trading:low")}</th>
              <th>{t("trading:close")}</th>
              <th>{t("trading:volume")}</th>
              {columns.map((column) => <th key={column.key}>{column.label}</th>)}
              <th>{t("chart:labels")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((candle) => {
              const labels = labelsByTime.get(candle.time) ?? [];
              return (
                <tr key={candle.time}>
                  <td>{formatTime(candle.time)}</td>
                  <td>{formatNumber(candle.open)}</td>
                  <td>{formatNumber(candle.high)}</td>
                  <td>{formatNumber(candle.low)}</td>
                  <td className={candle.close >= candle.open ? "positive" : "negative"}>{formatNumber(candle.close)}</td>
                  <td>{formatNumber(candle.volume)}</td>
                  {columns.map((column) => <td key={column.key}>{formatNumber(column.values.get(candle.time))}</td>)}
                  <td className="chart-data-table-labels">
                    {labels.length ? labels.map((label) => <span key={label}>{label}</span>) : "--"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
