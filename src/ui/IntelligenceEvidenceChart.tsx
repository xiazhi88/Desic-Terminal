import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import type { IntelligenceRecord } from "../lib/intelligence";
import { resolvedLocale } from "../i18n/runtime";

type EvidenceChartKind = "positioning" | "takerFlow" | "crowding" | "fundingBasis";

type IntelligenceEvidenceChartProps = {
  kind: EvidenceChartKind;
  items: IntelligenceRecord[];
  height?: number;
  ariaLabel: string;
};

function numberValue(record: IntelligenceRecord, ...keys: string[]) {
  for (const key of keys) {
    const raw = record[key];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string" && raw.trim() === "") continue;
    const value = typeof raw === "number" ? raw : Number(String(raw ?? "").replaceAll(",", ""));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function timeValue(record: IntelligenceRecord): UTCTimestamp | null {
  const raw = numberValue(record, "ts", "bucketAt", "eventAt", "fundingTime");
  if (raw === null || raw <= 0) return null;
  return Math.floor(raw > 10_000_000_000 ? raw / 1000 : raw) as UTCTimestamp;
}

function sortedItems(items: IntelligenceRecord[]) {
  const byTime = new Map<number, { item: IntelligenceRecord; time: UTCTimestamp }>();
  for (const item of items) {
    const time = timeValue(item);
    if (time === null) continue;
    const previous = byTime.get(Number(time));
    byTime.set(Number(time), {
      time,
      item: previous ? mergeEvidenceRecords(previous.item, item) : item
    });
  }
  return [...byTime.values()].sort((left, right) => Number(left.time) - Number(right.time));
}

function mergeEvidenceRecords(previous: IntelligenceRecord, incoming: IntelligenceRecord) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) continue;
    merged[key] = value;
  }
  return merged;
}

function formatTime(time: Time) {
  const seconds = typeof time === "number"
    ? time
    : typeof time === "string"
      ? Date.parse(time) / 1000
      : Date.UTC(time.year, time.month - 1, time.day) / 1000;
  return new Intl.DateTimeFormat(resolvedLocale(), {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(Number(seconds) * 1000));
}

function formatMetric(value: number) {
  return new Intl.NumberFormat(resolvedLocale(), {
    notation: Math.abs(value) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(value) >= 100 ? 2 : 5
  }).format(value);
}

export function IntelligenceEvidenceChart({ kind, items, height = 230, ariaLabel }: IntelligenceEvidenceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const points = sortedItems(items);
    const chart: IChartApi = createChart(container, {
      autoSize: true,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#020305" },
        textColor: "#7f8ba3",
        attributionLogo: false
      },
      grid: {
        vertLines: { color: "rgba(174,186,210,0.055)" },
        horzLines: { color: "rgba(174,186,210,0.07)" }
      },
      leftPriceScale: { visible: false },
      rightPriceScale: { borderColor: "rgba(174,186,210,0.16)" },
      timeScale: {
        borderColor: "rgba(174,186,210,0.16)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        barSpacing: 8,
        minBarSpacing: 3,
        tickMarkFormatter: (time: Time) => formatTime(time)
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(152,220,255,0.55)", labelBackgroundColor: "#10151d" },
        horzLine: { color: "rgba(152,220,255,0.28)", labelBackgroundColor: "#10151d" }
      },
      localization: {
        priceFormatter: formatMetric,
        timeFormatter: formatTime
      }
    });

    const series = new Map<string, ISeriesApi<"Line"> | ISeriesApi<"Histogram">>();
    const addLine = (key: string, color: string, priceScaleId = "right") => {
      const value = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        priceScaleId,
        lastValueVisible: true,
        priceLineVisible: false
      });
      series.set(key, value);
      return value;
    };
    const addHistogram = (key: string, color: string, priceScaleId = "") => {
      const value = chart.addSeries(HistogramSeries, {
        color,
        priceScaleId,
        lastValueVisible: false,
        priceLineVisible: false
      });
      series.set(key, value);
      return value;
    };

    if (kind === "positioning") {
      const price = addLine("价格", "#4cc9f0", "right");
      const oi = addLine("持仓量", "#39d98a", "oi");
      const oiDelta = addHistogram("OI变化", "#39d98a", "delta");
      chart.priceScale("oi").applyOptions({ scaleMargins: { top: 0.1, bottom: 0.58 } });
      chart.priceScale("delta").applyOptions({ scaleMargins: { top: 0.7, bottom: 0.02 } });
      price.setData(points.flatMap(({ item, time }) => {
        const value = numberValue(item, "last", "lastPrice", "price");
        return value === null ? [] : [{ time, value }];
      }));
      const oiPoints = points.flatMap(({ item, time }) => {
        const value = numberValue(item, "oiUsd", "oi");
        return value === null ? [] : [{ time, value }];
      });
      oi.setData(oiPoints);
      oiDelta.setData(oiPoints.map((point, index) => {
        const previous = oiPoints[index - 1]?.value ?? point.value;
        const value = point.value - previous;
        return { time: point.time, value, color: value >= 0 ? "rgba(38,190,124,0.8)" : "rgba(246,70,93,0.82)" };
      }));
    } else if (kind === "takerFlow") {
      const buy = addHistogram("主动买入", "rgba(38,190,124,0.82)");
      const sell = addHistogram("主动卖出", "rgba(246,70,93,0.82)");
      const net = addLine("净主动流", "#4cc9f0", "net");
      chart.priceScale("net").applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
      buy.setData(points.flatMap(({ item, time }) => {
        const value = numberValue(item, "buyVol", "buyVolume");
        return value === null ? [] : [{ time, value }];
      }));
      sell.setData(points.flatMap(({ item, time }) => {
        const value = numberValue(item, "sellVol", "sellVolume");
        return value === null ? [] : [{ time, value: -value }];
      }));
      net.setData(points.flatMap(({ item, time }) => {
        const value = numberValue(item, "netVol", "netVolume");
        return value === null ? [] : [{ time, value }];
      }));
    } else if (kind === "crowding") {
      for (const [key, label, color] of [
        ["accountRatio", "普通账户", "#5c9dff"],
        ["topAccountRatio", "精英人数", "#39d98a"],
        ["topPositionRatio", "精英仓位", "#ff5d73"]
      ] as const) {
        addLine(label, color).setData(points.flatMap(({ item, time }) => {
          const value = numberValue(item, key);
          return value === null ? [] : [{ time, value }];
        }));
      }
    } else {
      for (const [key, label, color] of [
        ["fundingRate", "结算资金费率", "#4cc9f0"],
        ["nextFundingRate", "预测资金费率", "#39d98a"],
        ["premium", "溢价", "#ffb454"]
      ] as const) {
        addLine(label, color).setData(points.flatMap(({ item, time }) => {
          const value = numberValue(item, key);
          return value === null ? [] : [{ time, value }];
        }));
      }
    }

    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        if (tooltip) tooltip.hidden = true;
        return;
      }
      const values = [...series.entries()].flatMap(([label, itemSeries]) => {
        const data = param.seriesData.get(itemSeries);
        if (!data || !("value" in data)) return [];
        return [`${label} ${formatMetric(data.value)}`];
      });
      tooltip.hidden = false;
      tooltip.textContent = `${formatTime(param.time)}  ${values.join("  ")}`;
    });

    container.dataset.chartReady = points.length > 0 ? "true" : "empty";
    return () => chart.remove();
  }, [height, items, kind]);

  return (
    <div className="intelligence-evidence-chart" ref={containerRef} style={{ height }} role="img" aria-label={ariaLabel} tabIndex={0}>
      <div className="intelligence-chart-tooltip" ref={tooltipRef} hidden />
      {items.length === 0 ? <span className="intelligence-chart-empty">等待本地采集数据</span> : null}
    </div>
  );
}
