import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type SeriesMarker,
  type SeriesMarkerBarPosition,
  type SeriesMarkerPricePosition,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import { resolvedLocale } from "../i18n/runtime";

export type ChartTimestamp = number;

export type ChartCandlePoint = {
  time: ChartTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type ChartVolumePoint = {
  time: ChartTimestamp;
  value: number;
  color: string;
};

export type ChartLinePoint = {
  time: ChartTimestamp;
  value: number;
};

export type ChartLineConfig = {
  key: string;
  color: string;
  lineWidth?: 1 | 2 | 3 | 4;
  visible?: boolean;
};

export const MAIN_CHART_PANE_ID = "main";

// Keep the time scale useful for both a broad market scan and close inspection
// of an individual execution without allowing data refreshes to narrow it again.
const DEFAULT_TIME_SCALE_BAR_SPACING = 8;
const MIN_TIME_SCALE_BAR_SPACING = 0.5;
const MAX_TIME_SCALE_BAR_SPACING = 0;

export type ChartPaneId = string;

export type ChartPane = {
  id: ChartPaneId;
  index: number;
  height: number;
};

export type ChartPaneOptions = {
  id: ChartPaneId;
  height?: number;
  stretchFactor?: number;
};

export type ChartIndicatorSeriesType = "line" | "histogram";

export type ChartIndicatorSeriesConfig = {
  key: string;
  paneId: ChartPaneId;
  type?: ChartIndicatorSeriesType;
  color?: string;
  lineWidth?: 1 | 2 | 3 | 4;
  visible?: boolean;
  priceScaleId?: string;
  lastValueVisible?: boolean;
  priceLineVisible?: boolean;
};

export type ChartIndicatorPoint = ChartLinePoint | ChartVolumePoint;

export type ChartMarkerPoint = {
  id: string;
  time: ChartTimestamp;
  position: "aboveBar" | "belowBar" | "atPriceTop" | "atPriceBottom" | "atPriceMiddle";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: string;
  text?: string;
  size?: number;
  price?: number;
};

export type ChartPriceLineOptions = {
  price: number;
  color: string;
  lineWidth?: 1 | 2 | 3 | 4;
  lineStyle?: number;
  axisLabelVisible?: boolean;
  title?: string;
};

export type ChartPriceLine = ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]>;

export type ChartVisibleLogicalRange = {
  from: number;
  to: number;
};

export type ChartCrosshairPosition = {
  time: ChartTimestamp;
  price: number;
};

export type TradingChartHandle = {
  /**
   * Remove every time-bearing point without destroying series or pane layout.
   * Replay uses this before replacing a page so the time scale never observes
   * old indicator data together with candles from the new page.
   */
  clearTemporalData: () => void;
  replaceSnapshot: (candles: ChartCandlePoint[], volumes: ChartVolumePoint[]) => void;
  appendLatest: (candle: ChartCandlePoint, volume: ChartVolumePoint) => void;
  updateLatest: (candle: ChartCandlePoint, volume: ChartVolumePoint) => void;
  setCandles: (data: ChartCandlePoint[]) => void;
  setVolumes: (data: ChartVolumePoint[]) => void;
  setLineData: (key: string, data: ChartLinePoint[], config?: Partial<ChartLineConfig>) => void;
  updateLineLatest: (key: string, point: ChartLinePoint) => void;
  setLineVisible: (key: string, visible: boolean) => void;
  removeLine: (key: string) => boolean;
  listPanes: () => ChartPane[];
  ensurePane: (options: ChartPaneOptions) => ChartPane;
  removePane: (paneId: ChartPaneId) => boolean;
  setPaneHeight: (paneId: ChartPaneId, height: number) => void;
  setPaneStretchFactor: (paneId: ChartPaneId, stretchFactor: number) => void;
  movePane: (paneId: ChartPaneId, targetIndex: number) => void;
  swapPanes: (firstPaneId: ChartPaneId, secondPaneId: ChartPaneId) => void;
  setIndicatorData: (config: ChartIndicatorSeriesConfig, data: ChartIndicatorPoint[]) => void;
  updateIndicatorLatest: (key: string, point: ChartIndicatorPoint) => void;
  setIndicatorVisible: (key: string, visible: boolean) => void;
  removeIndicator: (key: string) => boolean;
  setMarkers: (markers: ChartMarkerPoint[]) => void;
  fitContent: () => void;
  resetView: () => void;
  applyGridVisible: (visible: boolean) => void;
  timeToCoordinate: (time: ChartTimestamp) => number | null;
  coordinateToTime: (coordinate: number) => ChartTimestamp | null;
  priceToCoordinate: (price: number) => number | null;
  coordinateToPrice: (coordinate: number) => number | null;
  paneAtCoordinate: (coordinate: number) => ChartPaneId | null;
  createPriceLine: (options: ChartPriceLineOptions) => ChartPriceLine;
  removePriceLine: (line: ChartPriceLine) => void;
  onCrosshairMove: (handler: (position: ChartCrosshairPosition | null) => void) => () => void;
  setCrosshairTime: (time: ChartTimestamp | null) => void;
  setCrosshairPosition: (position: ChartCrosshairPosition | null) => void;
  onClick: (handler: (time: ChartTimestamp | null) => void) => () => void;
  onVisibleRangeChange: (handler: (range: ChartVisibleLogicalRange | null) => void) => () => void;
  getVisibleLogicalRange: () => ChartVisibleLogicalRange | null;
  setVisibleLogicalRange: (range: ChartVisibleLogicalRange) => void;
  /// Pins how many pixels one bar occupies. Setting a range alone is not enough
  /// after a full data replacement: bar spacing survives the swap, and with
  /// `maxBarSpacing: 0` the library allows up to half the chart per bar, which
  /// renders a handful of giant candles against the right edge.
  setBarSpacing: (spacing: number) => void;
  destroy: () => void;
};

export function createTradingChart(container: HTMLElement, lineConfigs: ChartLineConfig[]): TradingChartHandle {
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: "#000000" },
      textColor: "#9a9aa5",
      attributionLogo: false
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.04)" },
      horzLines: { color: "rgba(255,255,255,0.055)" }
    },
    rightPriceScale: {
      borderColor: "rgba(255,255,255,0.12)",
      scaleMargins: { top: 0.08, bottom: 0.22 }
    },
    timeScale: {
      borderColor: "rgba(255,255,255,0.12)",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: DEFAULT_TIME_SCALE_BAR_SPACING,
      minBarSpacing: MIN_TIME_SCALE_BAR_SPACING,
      maxBarSpacing: MAX_TIME_SCALE_BAR_SPACING,
      enableConflation: true,
      tickMarkFormatter: (time: Time) => formatShanghaiChartTime(time)
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: "rgba(255,255,255,0.48)", labelBackgroundColor: "#111113" },
      horzLine: { color: "rgba(255,255,255,0.48)", labelBackgroundColor: "#111113" }
    },
    localization: {
      priceFormatter: (price: number) => formatChartNumber(price),
      timeFormatter: (time: Time) => formatShanghaiChartTime(time, true)
    }
  });

  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: "#f6465d",
    downColor: "#0ecb81",
    borderUpColor: "#f6465d",
    borderDownColor: "#0ecb81",
    wickUpColor: "#f6465d",
    wickDownColor: "#0ecb81",
    priceLineColor: "#f4f4f6"
  });

  const markerPlugin: ISeriesMarkersPluginApi<Time> = createSeriesMarkers(candleSeries, [], {
    zOrder: "top",
    autoScale: true
  });

  const volumeSeries = chart.addSeries(HistogramSeries, {
    priceFormat: { type: "volume" },
    priceScaleId: "",
    lastValueVisible: false,
    priceLineVisible: false
  });
  let latestCandlePoint: ChartCandlePoint | null = null;
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  const paneIds = [MAIN_CHART_PANE_ID];
  const lineSeries = new Map<string, ISeriesApi<"Line">>();
  const indicatorSeries = new Map<
    string,
    { paneId: ChartPaneId; type: ChartIndicatorSeriesType; series: ISeriesApi<"Line"> | ISeriesApi<"Histogram"> }
  >();
  // lightweight-charts rejects an incremental update whose timestamp precedes
  // the last point. Layout changes can briefly leave late async updates in
  // flight, so keep a numeric cursor for every mutable series.
  let candleLatestTime: number | null = null;
  let volumeLatestTime: number | null = null;
  // Programmatic crosshair movement must target a candle that already exists
  // in this series. lightweight-charts throws when a time is in transit while
  // the series is being replaced, which is common during replay scrubbing.
  const candleCloseByTime = new Map<number, number>();
  const lineLatestTimes = new Map<string, number | null>();
  const indicatorLatestTimes = new Map<string, number | null>();

  const latestTimeOf = (points: readonly { time: UTCTimestamp }[]) => {
    const latest = points.at(-1);
    return latest ? Number(latest.time) : null;
  };

  const acceptsIncrementalPoint = (lastTime: number | null, nextTime: number) => lastTime === null || nextTime >= lastTime;

  const replaceCandleCrosshairData = (candles: readonly { time: UTCTimestamp; close: number }[]) => {
    candleCloseByTime.clear();
    for (const candle of candles) candleCloseByTime.set(Number(candle.time), candle.close);
  };

  const getPaneIndex = (paneId: ChartPaneId) => {
    const paneIndex = paneIds.indexOf(paneId);
    if (paneIndex < 0) throw new Error(`Chart pane not found: ${paneId}`);
    return paneIndex;
  };

  const markAllPanes = () => {
    container.querySelectorAll<HTMLElement>("[data-chart-pane-id]").forEach((element) => element.removeAttribute("data-chart-pane-id"));
    chart.panes().forEach((pane, index) => {
      const paneId = paneIds[index];
      if (paneId) pane.getHTMLElement()?.setAttribute("data-chart-pane-id", paneId);
    });
  };

  const toPane = (paneId: ChartPaneId): ChartPane => {
    const index = getPaneIndex(paneId);
    const pane = chart.panes()[index];
    if (!pane) throw new Error(`Chart pane is unavailable: ${paneId}`);
    const markPane = () => pane.getHTMLElement()?.setAttribute("data-chart-pane-id", paneId);
    markPane();
    if (!pane.getHTMLElement()) window.requestAnimationFrame(markPane);
    return { id: paneId, index, height: pane.getHeight() };
  };

  const ensurePane = (options: ChartPaneOptions): ChartPane => {
    if (!options.id) throw new Error("Chart pane id is required");
    if (paneIds.includes(options.id)) {
      const pane = toPane(options.id);
      if (options.stretchFactor !== undefined) chart.panes()[pane.index]?.setStretchFactor(validatePositiveNumber(options.stretchFactor, "Pane stretch factor"));
      return toPane(options.id);
    }
    const pane = chart.addPane(true);
    paneIds.push(options.id);
    if (options.height !== undefined) pane.setHeight(validatePositiveNumber(options.height, "Pane height"));
    if (options.stretchFactor !== undefined) pane.setStretchFactor(validatePositiveNumber(options.stretchFactor, "Pane stretch factor"));
    return toPane(options.id);
  };

  const createIndicatorSeries = (config: ChartIndicatorSeriesConfig) => {
    const paneIndex = getPaneIndex(config.paneId);
    const type = config.type ?? "line";
    const options = {
      color: config.color ?? "#67e8f9",
      lineWidth: config.lineWidth ?? 1,
      visible: config.visible ?? true,
      lastValueVisible: config.lastValueVisible ?? false,
      priceLineVisible: config.priceLineVisible ?? false,
      ...(config.priceScaleId !== undefined ? { priceScaleId: config.priceScaleId } : {})
    };
    const series = type === "histogram"
      ? chart.addSeries(HistogramSeries, options, paneIndex)
      : chart.addSeries(LineSeries, options, paneIndex);
    indicatorSeries.set(config.key, { paneId: config.paneId, type, series });
    return series;
  };
  for (const config of lineConfigs) {
    lineSeries.set(
      config.key,
      chart.addSeries(LineSeries, {
        color: config.color,
        lineWidth: config.lineWidth ?? 1,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: config.visible ?? true
      })
    );
    indicatorSeries.set(config.key, { paneId: MAIN_CHART_PANE_ID, type: "line", series: lineSeries.get(config.key)! });
  }

  return {
    clearTemporalData: () => {
      chart.clearCrosshairPosition();
      markerPlugin.setMarkers([]);
      candleSeries.setData([]);
      volumeSeries.setData([]);
      for (const series of lineSeries.values()) series.setData([]);
      for (const [key, indicator] of indicatorSeries) {
        if (lineSeries.has(key)) continue;
        if (indicator.type === "histogram") {
          (indicator.series as ISeriesApi<"Histogram">).setData([]);
        } else {
          (indicator.series as ISeriesApi<"Line">).setData([]);
        }
      }
      latestCandlePoint = null;
      candleLatestTime = null;
      volumeLatestTime = null;
      candleCloseByTime.clear();
      lineLatestTimes.clear();
      indicatorLatestTimes.clear();
    },
    replaceSnapshot: (candles, volumes) => {
      const nextCandles = toChartCandles(candles);
      const nextVolumes = toChartVolumes(volumes);
      candleSeries.setData(nextCandles);
      volumeSeries.setData(nextVolumes);
      candleLatestTime = latestTimeOf(nextCandles);
      volumeLatestTime = latestTimeOf(nextVolumes);
      replaceCandleCrosshairData(nextCandles);
      latestCandlePoint = normalizedLatestCandle(candles);
    },
    appendLatest: (candle, volume) => {
      const nextCandle = toChartCandle(candle);
      const nextVolume = toChartVolume(volume);
      if (!nextCandle || !nextVolume) return;
      const candleTime = Number(nextCandle.time);
      const volumeTime = Number(nextVolume.time);
      if (!acceptsIncrementalPoint(candleLatestTime, candleTime) || !acceptsIncrementalPoint(volumeLatestTime, volumeTime)) return;
      candleSeries.update(nextCandle);
      volumeSeries.update(nextVolume);
      candleLatestTime = candleTime;
      volumeLatestTime = volumeTime;
      candleCloseByTime.set(candleTime, nextCandle.close);
      latestCandlePoint = { ...candle, time: Number(nextCandle.time) };
    },
    updateLatest: (candle, volume) => {
      const nextCandle = toChartCandle(candle);
      const nextVolume = toChartVolume(volume);
      if (!nextCandle || !nextVolume) return;
      const candleTime = Number(nextCandle.time);
      const volumeTime = Number(nextVolume.time);
      if (!acceptsIncrementalPoint(candleLatestTime, candleTime) || !acceptsIncrementalPoint(volumeLatestTime, volumeTime)) return;
      candleSeries.update(nextCandle);
      volumeSeries.update(nextVolume);
      candleLatestTime = candleTime;
      volumeLatestTime = volumeTime;
      candleCloseByTime.set(candleTime, nextCandle.close);
      latestCandlePoint = { ...candle, time: Number(nextCandle.time) };
    },
    setCandles: (data) => {
      const nextCandles = toChartCandles(data);
      candleSeries.setData(nextCandles);
      candleLatestTime = latestTimeOf(nextCandles);
      replaceCandleCrosshairData(nextCandles);
      latestCandlePoint = normalizedLatestCandle(data);
    },
    setVolumes: (data) => {
      const nextVolumes = toChartVolumes(data);
      volumeSeries.setData(nextVolumes);
      volumeLatestTime = latestTimeOf(nextVolumes);
    },
    setLineData: (key, data, config) => {
      let series = lineSeries.get(key);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: config?.color ?? "#67e8f9",
          lineWidth: config?.lineWidth ?? 1,
          priceLineVisible: false,
          lastValueVisible: false,
          visible: config?.visible ?? true
        });
        lineSeries.set(key, series);
        indicatorSeries.set(key, { paneId: MAIN_CHART_PANE_ID, type: "line", series });
      } else if (config) {
        series.applyOptions({
          color: config.color,
          lineWidth: config.lineWidth,
          visible: config.visible
        });
      }
      const nextData = toChartLineData(data);
      series.setData(nextData);
      lineLatestTimes.set(key, latestTimeOf(nextData));
    },
    updateLineLatest: (key, point) => {
      const normalized = toChartLinePoint(point);
      const nextTime = normalized ? Number(normalized.time) : null;
      if (normalized && nextTime !== null && acceptsIncrementalPoint(lineLatestTimes.get(key) ?? null, nextTime)) {
        lineSeries.get(key)?.update(normalized);
        lineLatestTimes.set(key, nextTime);
      }
    },
    setLineVisible: (key, visible) => lineSeries.get(key)?.applyOptions({ visible }),
    removeLine: (key) => {
      const series = lineSeries.get(key);
      if (!series) return false;
      chart.removeSeries(series);
      lineSeries.delete(key);
      indicatorSeries.delete(key);
      lineLatestTimes.delete(key);
      return true;
    },
    listPanes: () => paneIds.map(toPane),
    ensurePane,
    removePane: (paneId) => {
      if (paneId === MAIN_CHART_PANE_ID) return false;
      const paneIndex = paneIds.indexOf(paneId);
      if (paneIndex < 0) return false;
      chart.removePane(paneIndex);
      paneIds.splice(paneIndex, 1);
      markAllPanes();
      window.requestAnimationFrame(markAllPanes);
      for (const [key, indicator] of indicatorSeries) {
        if (indicator.paneId === paneId) indicatorSeries.delete(key);
      }
      return true;
    },
    setPaneHeight: (paneId, height) => {
      chart.panes()[getPaneIndex(paneId)]?.setHeight(validatePositiveNumber(height, "Pane height"));
    },
    setPaneStretchFactor: (paneId, stretchFactor) => {
      chart.panes()[getPaneIndex(paneId)]?.setStretchFactor(validatePositiveNumber(stretchFactor, "Pane stretch factor"));
    },
    movePane: (paneId, targetIndex) => {
      const fromIndex = getPaneIndex(paneId);
      if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= paneIds.length) {
        throw new Error(`Invalid target pane index: ${targetIndex}`);
      }
      if (fromIndex === targetIndex) return;
      const pane = chart.panes()[fromIndex];
      if (!pane) throw new Error(`Chart pane is unavailable: ${paneId}`);
      pane.moveTo(targetIndex);
      paneIds.splice(fromIndex, 1);
      paneIds.splice(targetIndex, 0, paneId);
      markAllPanes();
    },
    swapPanes: (firstPaneId, secondPaneId) => {
      const firstIndex = getPaneIndex(firstPaneId);
      const secondIndex = getPaneIndex(secondPaneId);
      if (firstIndex === secondIndex) return;
      chart.swapPanes(firstIndex, secondIndex);
      [paneIds[firstIndex], paneIds[secondIndex]] = [paneIds[secondIndex]!, paneIds[firstIndex]!];
      markAllPanes();
    },
    setIndicatorData: (config, data) => {
      if (lineSeries.has(config.key)) {
        throw new Error(`Chart indicator key is reserved by a main-pane line: ${config.key}`);
      }
      ensurePane({ id: config.paneId });
      const existing = indicatorSeries.get(config.key);
      let series: ISeriesApi<"Line"> | ISeriesApi<"Histogram">;
      const type = config.type ?? existing?.type ?? "line";
      if (!existing || existing.type !== type) {
        if (existing) chart.removeSeries(existing.series);
        series = createIndicatorSeries({ ...config, type });
      } else {
        series = existing.series;
        if (existing.paneId !== config.paneId) series.moveToPane(getPaneIndex(config.paneId));
        existing.paneId = config.paneId;
        series.applyOptions(indicatorOptions(config));
      }
      if (type === "histogram") {
        const nextData = toChartIndicatorHistogramData(data, config.color);
        (series as ISeriesApi<"Histogram">).setData(nextData);
        indicatorLatestTimes.set(config.key, latestTimeOf(nextData));
      } else {
        const nextData = toChartIndicatorLineData(data);
        (series as ISeriesApi<"Line">).setData(nextData);
        indicatorLatestTimes.set(config.key, latestTimeOf(nextData));
      }
    },
    updateIndicatorLatest: (key, point) => {
      const indicator = indicatorSeries.get(key);
      if (!indicator || lineSeries.has(key)) return;
      if (indicator.type === "histogram") {
        const normalized = toChartIndicatorHistogramPoint(point);
        const nextTime = normalized ? Number(normalized.time) : null;
        if (normalized && nextTime !== null && acceptsIncrementalPoint(indicatorLatestTimes.get(key) ?? null, nextTime)) {
          (indicator.series as ISeriesApi<"Histogram">).update(normalized);
          indicatorLatestTimes.set(key, nextTime);
        }
        return;
      }
      const normalized = toChartIndicatorLinePoint(point);
      const nextTime = normalized ? Number(normalized.time) : null;
      if (normalized && nextTime !== null && acceptsIncrementalPoint(indicatorLatestTimes.get(key) ?? null, nextTime)) {
        (indicator.series as ISeriesApi<"Line">).update(normalized);
        indicatorLatestTimes.set(key, nextTime);
      }
    },
    setIndicatorVisible: (key, visible) => {
      indicatorSeries.get(key)?.series.applyOptions({ visible });
    },
    removeIndicator: (key) => {
      const indicator = indicatorSeries.get(key);
      if (!indicator || lineSeries.has(key)) return false;
      chart.removeSeries(indicator.series);
      indicatorSeries.delete(key);
      indicatorLatestTimes.delete(key);
      return true;
    },
    setMarkers: (markers) =>
      markerPlugin.setMarkers(
        markers.flatMap((marker): SeriesMarker<Time>[] => {
          const time = coerceChartTimestamp(marker.time);
          if (time === null) return [];
          const common = {
            id: marker.id,
            time: time as UTCTimestamp,
            shape: marker.shape,
            color: marker.color,
            text: marker.text,
            size: marker.size
          };
          if (marker.position.startsWith("atPrice") && Number.isFinite(marker.price)) {
            return [{
              ...common,
              position: marker.position as SeriesMarkerPricePosition,
              price: Number(marker.price)
            }];
          }
          return [{ ...common, position: marker.position as SeriesMarkerBarPosition }];
        }).sort((left, right) => Number(left.time) - Number(right.time))
      ),
    fitContent: () => chart.timeScale().fitContent(),
    resetView: () => {
      chart.applyOptions({
        rightPriceScale: {
          autoScale: true,
          borderColor: "rgba(255,255,255,0.12)",
          scaleMargins: { top: 0.08, bottom: 0.22 }
        },
        timeScale: {
          rightOffset: 8,
          barSpacing: DEFAULT_TIME_SCALE_BAR_SPACING,
          minBarSpacing: MIN_TIME_SCALE_BAR_SPACING,
          maxBarSpacing: MAX_TIME_SCALE_BAR_SPACING,
          enableConflation: true
        }
      });
      chart.timeScale().fitContent();
    },
    applyGridVisible: (visible) =>
      chart.applyOptions({
        grid: {
          vertLines: { color: visible ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0)" },
          horzLines: { color: visible ? "rgba(255,255,255,0.055)" : "rgba(255,255,255,0)" }
        }
      }),
    timeToCoordinate: (time) => {
      const normalized = coerceChartTimestamp(time);
      if (normalized === null) return null;
      const coordinate = chart.timeScale().timeToCoordinate(normalized as UTCTimestamp);
      return coordinate === null ? null : Number(coordinate);
    },
    coordinateToTime: (coordinate) => {
      const time = chart.timeScale().coordinateToTime(coordinate);
      return time === null ? null : coerceChartTimestamp(time);
    },
    priceToCoordinate: (price) => {
      const coordinate = candleSeries.priceToCoordinate(price);
      return coordinate === null ? null : Number(coordinate);
    },
    coordinateToPrice: (coordinate) => {
      const price = candleSeries.coordinateToPrice(coordinate);
      return price === null ? null : Number(price);
    },
    createPriceLine: (options) =>
      candleSeries.createPriceLine({
        price: options.price,
        color: options.color,
        lineWidth: options.lineWidth ?? 1,
        lineStyle: options.lineStyle ?? 2,
        axisLabelVisible: options.axisLabelVisible ?? true,
        title: options.title
      }),
    removePriceLine: (line) => candleSeries.removePriceLine(line),
    onCrosshairMove: (handler) => {
      const listener = (param: Parameters<typeof chart.subscribeCrosshairMove>[0] extends (arg: infer P) => void ? P : never) => {
        const time = param.time ? coerceChartTimestamp(param.time) : null;
        const price = param.point ? candleSeries.coordinateToPrice(param.point.y) : null;
        handler(time && price !== null && Number.isFinite(Number(price)) ? { time, price: Number(price) } : null);
      };
      chart.subscribeCrosshairMove(listener);
      return () => chart.unsubscribeCrosshairMove(listener);
    },
    paneAtCoordinate: (coordinate) => {
      if (!Number.isFinite(coordinate) || coordinate < 0) return null;
      let top = 0;
      for (let index = 0; index < paneIds.length; index += 1) {
        const height = chart.panes()[index]?.getHeight() ?? 0;
        if (coordinate >= top && coordinate <= top + height) return paneIds[index] ?? null;
        top += height;
      }
      return null;
    },
    setCrosshairTime: (time) => {
      if (time === null) {
        chart.clearCrosshairPosition();
        return;
      }
      const normalized = coerceChartTimestamp(time);
      const close = normalized === null ? undefined : candleCloseByTime.get(normalized);
      if (normalized === null || close === undefined || !Number.isFinite(close)) {
        chart.clearCrosshairPosition();
        return;
      }
      // Same mid-swap hazard as `setCrosshairPosition`: the library asserts on
      // its own internal state ("Value is null") when the series data no longer
      // covers the requested time, which the lookup above cannot detect.
      try {
        chart.setCrosshairPosition(close, normalized as UTCTimestamp, candleSeries);
      } catch {
        chart.clearCrosshairPosition();
      }
    },
    setCrosshairPosition: (position) => {
      if (!position) {
        chart.clearCrosshairPosition();
        return;
      }
      const normalized = coerceChartTimestamp(position.time);
      const fallbackPrice = normalized === null ? undefined : candleCloseByTime.get(normalized);
      if (normalized === null || fallbackPrice === undefined) {
        chart.clearCrosshairPosition();
        return;
      }
      // Replay paging replaces the candle series while the caller may still be
      // pointing at a time from the previous page. The library asserts on its
      // own internal state here ("Value is null") when the series has no data
      // for the requested time yet, which surfaced as an uncaught window error
      // while dragging the replay timeline. The time lookup above covers the
      // common case; this keeps a transient mid-swap state from throwing.
      try {
        chart.setCrosshairPosition(
          Number.isFinite(position.price) ? position.price : fallbackPrice,
          normalized as UTCTimestamp,
          candleSeries,
        );
      } catch {
        chart.clearCrosshairPosition();
      }
    },
    onClick: (handler) => {
      const listener = (param: Parameters<typeof chart.subscribeClick>[0] extends (arg: infer P) => void ? P : never) => {
        handler(param.time ? coerceChartTimestamp(param.time) : null);
      };
      chart.subscribeClick(listener);
      return () => chart.unsubscribeClick(listener);
    },
    onVisibleRangeChange: (handler) => {
      const listener = (range: LogicalRange | null) => {
        handler(range ? { from: Number(range.from), to: Number(range.to) } : null);
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(listener);
      return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(listener);
    },
    getVisibleLogicalRange: () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      return range ? { from: Number(range.from), to: Number(range.to) } : null;
    },
    setBarSpacing: (spacing) => {
      if (!Number.isFinite(spacing) || spacing <= 0) return;
      chart.timeScale().applyOptions({ barSpacing: spacing });
    },
    setVisibleLogicalRange: (range) => {
      if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) return;
      // Replay paging scrolls the view to follow the cursor while the series is
      // being replaced. The time scale asserts on its own internal state
      // ("Value is null") when it has no bars to map the range onto.
      try {
        chart.timeScale().setVisibleLogicalRange({ from: range.from, to: range.to });
      } catch {
        /* the next data update re-derives the visible range */
      }
    },
    destroy: () => chart.remove()
  };
}

function toChartCandles(data: ChartCandlePoint[]) {
  return uniqueSortedByTime(data, toChartCandle);
}

function toChartCandle(item: ChartCandlePoint) {
  const time = coerceChartTimestamp(item.time);
  if (time === null || ![item.open, item.high, item.low, item.close].every(Number.isFinite)) return null;
  return { ...item, time: time as UTCTimestamp };
}

function toChartVolumes(data: ChartVolumePoint[]) {
  return uniqueSortedByTime(data, toChartVolume);
}

function toChartVolume(item: ChartVolumePoint) {
  const time = coerceChartTimestamp(item.time);
  if (time === null || !Number.isFinite(item.value)) return null;
  return { ...item, time: time as UTCTimestamp };
}

function toChartLineData(data: ChartLinePoint[]) {
  return uniqueSortedByTime(data, toChartLinePoint);
}

function toChartLinePoint(item: ChartLinePoint) {
  const time = coerceChartTimestamp(item.time);
  if (time === null || !Number.isFinite(item.value)) return null;
  return { time: time as UTCTimestamp, value: item.value };
}

function toChartIndicatorLineData(data: ChartIndicatorPoint[]) {
  return uniqueSortedByTime(data, toChartIndicatorLinePoint);
}

function toChartIndicatorLinePoint(item: ChartIndicatorPoint) {
  const time = coerceChartTimestamp(item.time);
  if (time === null || !Number.isFinite(item.value)) return null;
  return { time: time as UTCTimestamp, value: item.value };
}

function toChartIndicatorHistogramData(data: ChartIndicatorPoint[], fallbackColor?: string) {
  return uniqueSortedByTime(data, (item) => {
    const point = toChartIndicatorHistogramPoint(item);
    return point ? { ...point, color: "color" in item ? item.color : fallbackColor } : null;
  });
}

function toChartIndicatorHistogramPoint(item: ChartIndicatorPoint) {
  const time = coerceChartTimestamp(item.time);
  if (time === null || !Number.isFinite(item.value)) return null;
  return { time: time as UTCTimestamp, value: item.value, color: "color" in item ? item.color : undefined };
}

function uniqueSortedByTime<T, R extends { time: UTCTimestamp }>(data: readonly T[], project: (item: T) => R | null): R[] {
  const values = new Map<number, R>();
  for (const item of data) {
    const point = project(item);
    if (point) values.set(Number(point.time), point);
  }
  return [...values.values()].sort((left, right) => Number(left.time) - Number(right.time));
}

function normalizedLatestCandle(data: readonly ChartCandlePoint[]) {
  const normalized = toChartCandles([...data]);
  const latest = normalized.at(-1);
  return latest ? { ...latest, time: Number(latest.time) } : null;
}

/** Converts runtime BusinessDay/Date/string values before they reach lightweight-charts. */
function coerceChartTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return Math.floor(value.getTime() / 1000);
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.floor(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  if (!value || typeof value !== "object") return null;
  const source = value as { year?: unknown; month?: unknown; day?: unknown; time?: unknown; timestamp?: unknown; ts?: unknown };
  for (const candidate of [source.timestamp, source.time, source.ts]) {
    const normalized = coerceChartTimestamp(candidate);
    if (normalized !== null) return normalized;
  }
  const year = Number(source.year);
  const month = Number(source.month);
  const day = Number(source.day);
  if ([year, month, day].every(Number.isInteger)) {
    const timestamp = Date.UTC(year, month - 1, day) / 1000;
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function validatePositiveNumber(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
  return value;
}

function indicatorOptions(config: ChartIndicatorSeriesConfig) {
  return {
    ...(config.color !== undefined ? { color: config.color } : {}),
    ...(config.lineWidth !== undefined ? { lineWidth: config.lineWidth } : {}),
    ...(config.visible !== undefined ? { visible: config.visible } : {}),
    ...(config.priceScaleId !== undefined ? { priceScaleId: config.priceScaleId } : {}),
    ...(config.lastValueVisible !== undefined ? { lastValueVisible: config.lastValueVisible } : {}),
    ...(config.priceLineVisible !== undefined ? { priceLineVisible: config.priceLineVisible } : {})
  };
}

function formatChartNumber(value?: number) {
  if (!Number.isFinite(value)) return "--";
  const numeric = Number(value);
  if (Math.abs(numeric) >= 1000) return numeric.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (Math.abs(numeric) >= 1) return numeric.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function formatShanghaiChartTimestamp(timestampSeconds: number, withDate = false) {
  return formatShanghaiChartDate(new Date(timestampSeconds * 1000), withDate);
}

export function formatShanghaiChartTime(time: Time, withDate = false) {
  const date = chartTimeToShanghaiDate(time);
  return formatShanghaiChartDate(date, withDate);
}

function formatShanghaiChartDate(date: Date, withDate = false) {
  const parts = new Intl.DateTimeFormat(resolvedLocale(), {
    timeZone: "Asia/Shanghai",
    year: withDate ? "2-digit" : undefined,
    month: withDate ? "2-digit" : undefined,
    day: withDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const timeText = `${value("hour")}:${value("minute")}`;
  if (!withDate) return timeText;
  return `${value("year")}/${value("month")}/${value("day")} ${timeText}`;
}

function chartTimeToShanghaiDate(time: Time) {
  if (typeof time === "number") return new Date(time * 1000);
  if (typeof time === "string") {
    const parsed = Date.parse(`${time}T00:00:00+08:00`);
    return Number.isFinite(parsed) ? new Date(parsed) : new Date(time);
  }
  return new Date(`${time.year}-${padTimePart(time.month)}-${padTimePart(time.day)}T00:00:00+08:00`);
}

function padTimePart(value: number) {
  return String(value).padStart(2, "0");
}
