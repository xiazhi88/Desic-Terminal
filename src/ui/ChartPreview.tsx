import { useCallback, useEffect, useRef, useState } from "react";
import { KlineChart, type ChartHistoryLoadOutcome } from "./KlineChart";
import type { Candle, ChartFillMarker, ChartOrderLine, ChartPositionRange, ChartSignalMarker, Ticker } from "../types";
import { useTranslation } from "react-i18next";
import { chartPositionLabel, formatChartAction, formatChartOrderLabel, formatChartPosition } from "../lib/chartTradeSemantics";

export function ChartPreview() {
  const { t } = useTranslation(["trading", "chart"]);
  const [{ symbol, candles }, setPreviewSeries] = useState(() => ({
    symbol: "BTC-USDT-SWAP",
    candles: buildPreviewCandles(62800)
  }));
  const [historyRequestCount, setHistoryRequestCount] = useState(0);
  const historyEnabledRef = useRef(false);
  const historyFailuresRemainingRef = useRef(0);
  useEffect(() => {
    const switchSeries = (event: Event) => {
      const next = (event as CustomEvent<{ symbol?: string }>).detail?.symbol;
      if (next === "BTC-USDT-SWAP" || next === "ETH-USDT-SWAP") {
        setPreviewSeries({
          symbol: next,
          candles: buildPreviewCandles(next === "ETH-USDT-SWAP" ? 1880 : 62800)
        });
        setHistoryRequestCount(0);
      }
    };
    const enableHistory = (event: Event) => {
      historyEnabledRef.current = true;
      historyFailuresRemainingRef.current = (event as CustomEvent<{ failOnce?: boolean }>).detail?.failOnce ? 1 : 0;
    };
    window.addEventListener("desic:chart-preview-series", switchSeries);
    window.addEventListener("desic:chart-preview-history", enableHistory);
    return () => {
      window.removeEventListener("desic:chart-preview-series", switchSeries);
      window.removeEventListener("desic:chart-preview-history", enableHistory);
    };
  }, []);
  const loadMoreHistory = useCallback(async ({ firstTime }: { firstTime: number }): Promise<ChartHistoryLoadOutcome> => {
    if (!historyEnabledRef.current) return { status: "deferred" };
    setHistoryRequestCount((count) => count + 1);
    if (historyFailuresRemainingRef.current > 0) {
      historyFailuresRemainingRef.current -= 1;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      return { status: "failed", message: "preview history failure" };
    }
    let earliestTime = firstTime;
    setPreviewSeries((current) => {
      if (current.candles[0]?.time < firstTime) {
        earliestTime = current.candles[0].time;
        return current;
      }
      const earlier = buildEarlierPreviewCandles(
        firstTime,
        current.candles[0]?.open ?? 62800,
        80
      );
      earliestTime = earlier[0].time;
      return { ...current, candles: [...earlier, ...current.candles] };
    });
    return { status: "loaded", earliestTime };
  }, []);
  const last = candles[candles.length - 1];
  const ticker: Ticker = {
    instId: symbol,
    last: String(last.close),
    lastSz: "0.12",
    askPx: String(last.close + 0.1),
    askSz: "2.4",
    bidPx: String(last.close - 0.1),
    bidSz: "1.8",
    open24h: String(candles[Math.max(0, candles.length - 120)].open),
    high24h: String(Math.max(...candles.slice(-120).map((item) => item.high))),
    low24h: String(Math.min(...candles.slice(-120).map((item) => item.low))),
    vol24h: "41230",
    volCcy24h: "284213000",
    ts: Date.now()
  };

  return (
    <main
      className="chart-preview-page"
      data-preview-series={symbol}
      data-history-request-count={historyRequestCount}
      data-earliest-candle-time={candles[0]?.time ?? 0}
    >
      <div className="chart-preview-shell">
        <KlineChart
          candles={candles}
          ticker={ticker}
          symbol={symbol}
          onNeedMoreHistory={loadMoreHistory}
          signals={buildPreviewSignals(candles, t)}
          fills={buildPreviewFills(candles, t)}
          positionRanges={buildPreviewPositionRanges(last.close, t)}
          orderLines={buildPreviewOrderLines(last.close, t)}
          onOrderLineCancel={() => undefined}
          onPositionLineCloseRequest={() => undefined}
        />
      </div>
    </main>
  );
}

function buildPreviewCandles(basePrice: number): Candle[] {
  const start = Date.UTC(2026, 6, 8, 0, 0, 0) / 1000;
  let price = basePrice;
  return Array.from({ length: 260 }, (_, index) => {
    const wave = Math.sin(index / 12) * 80 + Math.cos(index / 27) * 130;
    const impulse = index > 190 ? (index - 190) * 5.6 : 0;
    const open = price;
    const close = open + wave * 0.08 + impulse * 0.15 + Math.sin(index * 1.7) * 22;
    const high = Math.max(open, close) + 35 + Math.abs(Math.sin(index)) * 42;
    const low = Math.min(open, close) - 35 - Math.abs(Math.cos(index)) * 38;
    const volume = 180 + Math.abs(close - open) * 4 + (index > 190 ? 320 : 0);
    price = close;
    return {
      time: start + index * 60,
      open,
      high,
      low,
      close,
      volume,
      confirm: true
    };
  });
}

function buildEarlierPreviewCandles(firstTime: number, anchorPrice: number, count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const time = firstTime - (count - index) * 60;
    const offset = count - index;
    const close = anchorPrice - Math.sin(offset / 7) * 18 - offset * 0.7;
    const open = close - Math.cos(offset / 5) * 12;
    return {
      time,
      open,
      high: Math.max(open, close) + 24,
      low: Math.min(open, close) - 24,
      close,
      volume: 160 + offset * 2,
      confirm: true
    };
  });
}

function buildPreviewOrderLines(lastPrice: number, t: ReturnType<typeof useTranslation>["t"]): ChartOrderLine[] {
  return [
    {
      id: "preview-position-liq",
      type: "liquidation",
      label: `${chartPositionLabel("long", "0.08", t)} · ${t("trading:liquidationPrice")}`,
      price: lastPrice - 760,
      posSide: "long",
      color: "#f59e0b",
      tone: "warning"
    },
    {
      id: "preview-editable-limit",
      type: "limit",
      label: formatChartOrderLabel("limit", { side: "buy", posSide: "long" }, "0.08", t),
      price: lastPrice + 220,
      side: "buy",
      posSide: "long",
      color: "#f6465d",
      tone: "positive",
      editable: true,
      editKind: "order-price",
      orderId: "preview-order-1",
      clientOrderId: "preview-client-1",
      size: "0.08"
    }
  ];
}

function buildPreviewSignals(candles: Candle[], t: ReturnType<typeof useTranslation>["t"]): ChartSignalMarker[] {
  const pick = (offset: number) => candles[Math.max(0, candles.length - offset)];
  const aiLong = pick(54);
  const strategyShort = pick(28);
  return [
    {
      id: "preview-ai-long",
      time: aiLong.time + 18,
      price: aiLong.low + (aiLong.close - aiLong.low) * 0.45,
      side: "buy",
      posSide: "long",
      source: "ai",
      label: t("chart:bullish")
    },
    {
      id: "preview-strategy-short",
      time: strategyShort.time + 20,
      price: strategyShort.high - (strategyShort.high - strategyShort.open) * 0.28,
      side: "sell",
      posSide: "short",
      source: "strategy",
      label: t("chart:bearish")
    }
  ];
}

function buildPreviewFills(candles: Candle[], t: ReturnType<typeof useTranslation>["t"]): ChartFillMarker[] {
  const pick = (offset: number) => candles[Math.max(0, candles.length - offset)];
  const openFill = pick(88);
  const reduceFill = pick(34);
  const linkedFill = pick(16);
  return [
    {
      id: "preview-fill-open-long",
      time: openFill.time + 12,
      price: openFill.close,
      side: "buy",
      posSide: "long",
      size: "0.08",
      label: formatChartAction({ side: "buy", posSide: "long" }, "0.08", t)
    },
    {
      id: "preview-fill-open-long-follow-up",
      time: openFill.time + 18,
      price: openFill.close + 0.4,
      side: "buy",
      posSide: "long",
      size: "0.02",
      label: formatChartAction({ side: "buy", posSide: "long" }, "0.02", t)
    },
    {
      id: "preview-fill-reduce-long",
      time: reduceFill.time + 14,
      price: reduceFill.close,
      side: "sell",
      posSide: "long",
      size: "0.03",
      pnl: "18.42",
      label: `${formatChartAction({ side: "sell", posSide: "long" }, "0.03", t)} +18.42U`
    },
    {
      id: "preview-fill-linked-opportunity",
      time: linkedFill.time + 10,
      price: linkedFill.close,
      side: "buy",
      posSide: "long",
      size: "0.01",
      opportunityId: "preview-opportunity-executed-long",
      label: formatChartAction({ side: "buy", posSide: "long" }, "0.01", t)
    }
  ];
}

function buildPreviewPositionRanges(lastPrice: number, t: ReturnType<typeof useTranslation>["t"]): ChartPositionRange[] {
  return [
    {
      id: "preview-position-range",
      instId: "BTC-USDT-SWAP",
      entryPrice: lastPrice - 180,
      currentPrice: lastPrice,
      posSide: "long",
      size: "0.08",
      pnl: "34.62",
      pnlRatio: "0.024",
      label: formatChartPosition("long", "0.08", t)
    }
  ];
}
