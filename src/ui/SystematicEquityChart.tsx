import { useEffect, useMemo, useRef } from "react";
import { ColorType, createChart, LineSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { SystematicEquityPoint } from "../lib/systematic";

type Props = Readonly<{
  points: readonly SystematicEquityPoint[];
  negative: boolean;
  label: string;
  cursorTimeMs?: number | null;
}>;

function equityPointAtOrBefore(
  points: readonly SystematicEquityPoint[],
  cursorTimeMs: number,
): SystematicEquityPoint | null {
  let low = 0;
  let high = points.length - 1;
  let result: SystematicEquityPoint | null = null;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
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

export function SystematicEquityChart({ points, negative, label, cursorTimeMs = null }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const signature = useMemo(
    () => points.length ? `${points.length}:${points[0]?.timeMs}:${points.at(-1)?.timeMs}:${points.at(-1)?.equityUsdt}` : "empty",
    [points]
  );
  const cursorPoint = useMemo(() => {
    if (!cursorTimeMs) return null;
    return equityPointAtOrBefore(points, cursorTimeMs);
  }, [cursorTimeMs, points]);

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
      rightPriceScale: { borderColor: "rgba(182,194,218,0.13)", minimumWidth: 74 },
      timeScale: { borderColor: "rgba(182,194,218,0.13)", timeVisible: true, secondsVisible: false, rightOffset: 2 },
      crosshair: {
        vertLine: { color: "rgba(239,242,248,0.35)", labelBackgroundColor: "#151923" },
        horzLine: { color: "rgba(239,242,248,0.35)", labelBackgroundColor: "#151923" }
      }
    });
    const series: ISeriesApi<"Line"> = chart.addSeries(LineSeries, {
      color: negative ? "#ef7181" : "#39c99a",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 3,
      crosshairMarkerBorderColor: "#0c0f15",
      crosshairMarkerBackgroundColor: negative ? "#ef7181" : "#39c99a"
    });
    series.setData(points.map((point) => ({ time: Math.floor(point.timeMs / 1_000) as UTCTimestamp, value: point.equityUsdt })));
    chart.timeScale().fitContent();
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      if (chartRef.current === chart) chartRef.current = null;
      if (seriesRef.current === series) seriesRef.current = null;
      chart?.remove();
      chart = null;
    };
  }, [negative, points, signature]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    if (!cursorPoint) {
      chart.clearCrosshairPosition();
      return;
    }
    try {
      chart.setCrosshairPosition(
        cursorPoint.equityUsdt,
        Math.floor(cursorPoint.timeMs / 1_000) as UTCTimestamp,
        series,
      );
    } catch {
      // A chart can be recreated between replay ticks. A stale replay cursor
      // should clear harmlessly instead of taking down the whole review page.
      chart.clearCrosshairPosition();
    }
  }, [cursorPoint]);

  return <div ref={hostRef} className="systematic-lab-equity-chart" aria-label={label} />;
}
