import { useEffect, useMemo, useRef } from "react";
import { AreaSeries, ColorType, createChart, LineSeries, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from "lightweight-charts";
import type { SystematicEquityPoint } from "../lib/systematic";
import { formatShanghaiChartTimestamp } from "./chartAdapter";

type Props = Readonly<{
  points: readonly SystematicEquityPoint[];
  negative: boolean;
  label: string;
  cursorTimeMs?: number | null;
}>;

function pointAtOrBefore(points: readonly SystematicEquityPoint[], cursorTimeMs: number): SystematicEquityPoint | null {
  let low = 0;
  let high = points.length - 1;
  let result: SystematicEquityPoint | null = null;
  while (low <= high) {
    const middle = low + Math.floor((low + high) / 2);
    const point = points[middle];
    if (!point) break;
    if (point.timeMs <= cursorTimeMs) {
      result = point;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function drawdownPercentSeries(points: readonly SystematicEquityPoint[]) {
  let peak = points[0]?.equityUsdt ?? 0;
  return points.map((point) => {
    peak = Math.max(peak, point.equityUsdt);
    const drawdownPct = peak > 0 ? (point.equityUsdt - peak) / peak * 100 : 0;
    return { time: Math.floor(point.timeMs / 1_000) as UTCTimestamp, value: drawdownPct };
  });
}

export function SystematicEquityChart({ points, negative, label, cursorTimeMs = null }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const equitySeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const signature = useMemo(
    () => points.length ? `${points.length}:${points[0]?.timeMs}:${points.at(-1)?.timeMs}:${points.at(-1)?.equityUsdt}` : "empty",
    [points]
  );
  const cursorPoint = useMemo(() => cursorTimeMs ? pointAtOrBefore(points, cursorTimeMs) : null, [cursorTimeMs, points]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !points.length) return;
    let chart: IChartApi | null = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0c0f15" },
        textColor: "#7c8698",
        attributionLogo: false,
        fontSize: 10
      },
      grid: {
        vertLines: { color: "rgba(182,194,218,0.045)" },
        horzLines: { color: "rgba(182,194,218,0.06)" }
      },
      rightPriceScale: {
        borderColor: "rgba(182,194,218,0.13)",
        minimumWidth: 74,
        scaleMargins: { top: 0.06, bottom: 0.28 }
      },
      timeScale: {
        borderColor: "rgba(182,194,218,0.13)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        tickMarkFormatter: (time: Time) => formatShanghaiChartTimestamp(Number(time), false)
      },
      crosshair: {
        vertLine: { color: "rgba(239,242,248,0.35)", labelBackgroundColor: "#151923" },
        horzLine: { color: "rgba(239,242,248,0.35)", labelBackgroundColor: "#151923" }
      }
    });
    const drawdownSeries = chart.addSeries(AreaSeries, {
      priceScaleId: "drawdown",
      lineColor: "rgba(239,113,129,0.9)",
      topColor: "rgba(239,113,129,0.02)",
      bottomColor: "rgba(239,113,129,0.22)",
      lineWidth: 1,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("drawdown").applyOptions({
      visible: false,
      borderVisible: false,
      scaleMargins: { top: 0.76, bottom: 0.06 }
    });
    const equitySeries: ISeriesApi<"Line"> = chart.addSeries(LineSeries, {
      color: negative ? "#ef7181" : "#39c99a",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 3,
      crosshairMarkerBorderColor: "#0c0f15",
      crosshairMarkerBackgroundColor: negative ? "#ef7181" : "#39c99a"
    });
    drawdownSeries.setData(drawdownPercentSeries(points));
    equitySeries.setData(points.map((point) => ({ time: Math.floor(point.timeMs / 1_000) as UTCTimestamp, value: point.equityUsdt })));
    chart.timeScale().fitContent();
    chartRef.current = chart;
    equitySeriesRef.current = equitySeries;
    return () => {
      if (chartRef.current === chart) chartRef.current = null;
      if (equitySeriesRef.current === equitySeries) equitySeriesRef.current = null;
      chart?.remove();
      chart = null;
    };
  }, [negative, points, signature]);

  useEffect(() => {
    const chart = chartRef.current;
    const equitySeries = equitySeriesRef.current;
    if (!chart || !equitySeries) return;
    if (!cursorPoint) {
      chart.clearCrosshairPosition();
      return;
    }
    try {
      chart.setCrosshairPosition(cursorPoint.equityUsdt, Math.floor(cursorPoint.timeMs / 1_000) as UTCTimestamp, equitySeries);
    } catch {
      chart.clearCrosshairPosition();
    }
  }, [cursorPoint]);

  return <div ref={hostRef} className="systematic-lab-equity-chart" aria-label={label} />;
}
