import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Candle } from "../../types";
import type { TradingChartHandle } from "../chartAdapter";
import { orderBookWallsFor } from "../../lib/orderBookWalls";
import { invokeDesktop, isTauriRuntime } from "../../lib/tauri";
import { markActiveIntelligenceInstrument, queryDerivatives } from "../../lib/intelligence";
import { OrderFlowPrimitive, type VolumeProfileData } from "./OrderFlowPrimitive";
import {
  buildDeltaSeries,
  detectDivergences,
  parseLiquidations,
  parseTakerItems,
  takerPeriodFor,
  timeframeSeconds,
  type LiquidationMark,
  type TakerBucket
} from "./orderFlowModel";
import "./orderflow.css";

type UiText = (english: string, chinese: string) => string;

export const ORDER_FLOW_PANE_ID = "orderflow-cvd";
const DELTA_KEY = "orderflow:delta";
const CVD_KEY = "orderflow:cvd";
const PROFILE_REFRESH_MS = 60_000;
/** 成交量分布固定取最近 N 根 K 线：不随缩放 / 拖动重算，只随新 K 线与每分钟刷新变化。 */
const PROFILE_LOOKBACK_BARS = 300;
const DERIVATIVES_REFRESH_MS = 60_000;
const REMOTE_BACKFILL_COOLDOWN_MS = 5 * 60_000;
const BID_RGB = "25, 217, 154";
const ASK_RGB = "255, 77, 106";

/** 浏览器预览用的合成数据（桌面端不传）。 */
export type OrderFlowPreviewData = {
  profile: VolumeProfileData;
  taker: TakerBucket[];
  liquidations: LiquidationMark[];
};

type Coverage = { covered: number; expected: number } | null;

export type OrderFlowLayerState = {
  enabled: boolean;
  profileCoverage: Coverage;
  takerPeriod: "5m" | "1H";
  takerPoints: number;
  takerNotice: string | null;
  liquidationCount: number;
  wallCount: number;
  divergenceCount: number;
};

type VolumeProfileResponse = {
  bucket: number;
  levels: Array<[number, number, number]>;
  poc: number | null;
  valueAreaHigh: number | null;
  valueAreaLow: number | null;
  coveredMinutes: number;
  expectedMinutes: number;
};

const remoteBackfillAt = new Map<string, number>();
// 最近一次结果缓存（同一窗口内跨图表共享）：打开 / 切换合约或周期时先画上次的结果，后台再刷新。
const profileCache = new Map<string, VolumeProfileResponse>();
const takerCache = new Map<string, TakerBucket[]>();
const liquidationCache = new Map<string, LiquidationMark[]>();

function mergeTakerBuckets(local: readonly TakerBucket[], remote: readonly TakerBucket[]) {
  const byTs = new Map<number, TakerBucket>();
  for (const bucket of remote) byTs.set(bucket.ts, bucket);
  for (const bucket of local) byTs.set(bucket.ts, bucket);
  return [...byTs.values()].sort((left, right) => left.ts - right.ts);
}

/** 订单流模式：成交量分布 + 主动买卖差（Delta / CVD）+ 当前大单墙 + 清算标记 + 背离。 */
export function useOrderFlowLayer({ chartRef, chartVersion, enabled, symbol, timeframe, candles, text, preview = null }: {
  chartRef: MutableRefObject<TradingChartHandle | null>;
  chartVersion: number;
  enabled: boolean;
  symbol: string;
  timeframe: string;
  candles: readonly Candle[];
  text: UiText;
  preview?: OrderFlowPreviewData | null;
}): OrderFlowLayerState {
  const primitiveRef = useRef<OrderFlowPrimitive | null>(null);
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const [profileCoverage, setProfileCoverage] = useState<Coverage>(null);
  const [taker, setTaker] = useState<TakerBucket[]>([]);
  const [takerNotice, setTakerNotice] = useState<string | null>(null);
  const [liquidationCount, setLiquidationCount] = useState(0);
  const [wallCount, setWallCount] = useState(0);
  const barSeconds = timeframeSeconds(timeframe) ?? 60;
  const takerPeriod = takerPeriodFor(barSeconds);
  const firstCandleTime = candles[0]?.time ?? 0;

  const labels = useMemo(() => ({
    poc: "POC",
    valueArea: text("VA", "价值区"),
    bidWall: text("Bid wall", "买墙"),
    askWall: text("Ask wall", "卖墙"),
    wallAge: text("up ", "已挂 "),
    seconds: text("s", "秒"),
    minutes: text("m", "分"),
    hours: text("h", "小时"),
    contracts: text(" ct", "张"),
    bearishDivergence: text("Divergence · buyers not following", "背离 · 主动买没跟上"),
    bullishDivergence: text("Divergence · sellers not following", "背离 · 主动卖没跟上"),
    longLiquidated: text("Longs liquidated", "多头爆仓"),
    shortLiquidated: text("Shorts liquidated", "空头爆仓")
  }), [text]);

  // 挂载图元。
  useEffect(() => {
    const chart = chartRef.current;
    if (!enabled || !chart) return;
    const primitive = new OrderFlowPrimitive(labels);
    chart.attachCandlePrimitive(primitive);
    primitiveRef.current = primitive;
    return () => {
      chart.detachCandlePrimitive(primitive);
      primitiveRef.current = null;
    };
  }, [chartRef, chartVersion, enabled, labels]);

  // 当前大单墙：跟随盘口，每秒最多刷新一次。
  useEffect(() => {
    if (!enabled) return;
    const tracker = orderBookWallsFor(symbol);
    let last = 0;
    const push = () => {
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      const walls = tracker.currentWalls();
      primitiveRef.current?.setWalls(walls);
      setWallCount(walls.length);
    };
    push();
    return tracker.subscribe(push);
  }, [chartVersion, enabled, symbol]);

  // 让情报采集器持续同步当前交易对的主动成交与清算。
  useEffect(() => {
    if (!enabled || !isTauriRuntime()) return;
    void markActiveIntelligenceInstrument(symbol).catch(() => undefined);
  }, [enabled, symbol]);

  // 成交量分布：固定锚定最近 PROFILE_LOOKBACK_BARS 根（到最新一根为止），新 K 线出现时与每分钟刷新；
  // 不跟随可见范围——按可见范围计算时，每次缩放 / 拖动都会换一批样本，POC 与价值区大幅跳动。
  const lastCandleTime = candles.at(-1)?.time ?? 0;
  useEffect(() => {
    const chart = chartRef.current;
    if (!enabled || !chart) return;
    if (preview) {
      primitiveRef.current?.setProfile(preview.profile);
      setProfileCoverage(null);
      return;
    }
    if (!isTauriRuntime()) return;
    let active = true;
    const cacheKey = `${symbol}:${barSeconds}`;
    const cached = profileCache.get(cacheKey);
    if (cached) {
      primitiveRef.current?.setProfile(cached);
      setProfileCoverage({ covered: cached.coveredMinutes, expected: cached.expectedMinutes });
    }
    const load = async () => {
      const series = candlesRef.current;
      if (series.length < 2) return;
      const last = series.at(-1)!.time;
      const toMs = (last + barSeconds) * 1000 - 60_000;
      // 后端最多接受 400 天：周线等高周期截到约 398 天。
      const fromMs = Math.max((last - (PROFILE_LOOKBACK_BARS - 1) * barSeconds) * 1000, toMs - 398 * 86_400_000);
      try {
        const profile = await invokeDesktop<VolumeProfileResponse>("order_flow_volume_profile", { instId: symbol, fromMs, toMs: Math.max(toMs, fromMs + 60_000), rows: 120 }, { quiet: true });
        if (!profile) return;
        profileCache.set(cacheKey, profile);
        if (!active) return;
        primitiveRef.current?.setProfile(profile);
        setProfileCoverage({ covered: profile.coveredMinutes, expected: profile.expectedMinutes });
      } catch {
        if (active) setProfileCoverage({ covered: 0, expected: 0 });
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), PROFILE_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [barSeconds, chartRef, chartVersion, enabled, lastCandleTime, preview, symbol]);

  // 主动成交与清算：两路本地查询并行，先画本地结果；本地点数不足时后台向交易所补拉一次（有冷却），
  // 补拉结果到达后与本地合并再更新，不阻塞首屏。之后每分钟读本地。
  useEffect(() => {
    if (!enabled) {
      setTaker([]);
      return;
    }
    if (preview) {
      setTaker(preview.taker);
      primitiveRef.current?.setLiquidations(preview.liquidations);
      setLiquidationCount(preview.liquidations.length);
      setTakerNotice(null);
      return;
    }
    if (!isTauriRuntime()) {
      setTakerNotice(text("Order flow data needs the desktop app", "订单流数据仅在桌面端可用"));
      return;
    }
    let active = true;
    const startTime = firstCandleTime ? firstCandleTime * 1000 : Date.now() - 86_400_000;
    const takerKey = `${symbol}:${takerPeriod.period}`;
    const cachedTaker = takerCache.get(takerKey);
    if (cachedTaker) setTaker(cachedTaker);
    const cachedLiquidations = liquidationCache.get(symbol);
    if (cachedLiquidations) {
      primitiveRef.current?.setLiquidations(cachedLiquidations);
      setLiquidationCount(cachedLiquidations.length);
    }
    const applyTaker = (buckets: TakerBucket[]) => {
      takerCache.set(takerKey, buckets);
      if (!active) return;
      setTaker(buckets);
      setTakerNotice(buckets.length === 0 ? text("No taker-flow data yet; syncing", "暂无主动成交数据，正在同步") : null);
    };
    const load = async () => {
      const [takerResult, liquidationResult] = await Promise.allSettled([
        queryDerivatives("takerFlow", { instId: symbol, period: takerPeriod.period, startTime, limit: 2000, localOnly: true }),
        queryDerivatives("liquidations", { instId: symbol, startTime, limit: 500, localOnly: true })
      ]);
      if (takerResult.status === "fulfilled") {
        const local = parseTakerItems(takerResult.value.items);
        applyTaker(local);
        if (local.length < 12 && Date.now() - (remoteBackfillAt.get(takerKey) ?? 0) > REMOTE_BACKFILL_COOLDOWN_MS) {
          remoteBackfillAt.set(takerKey, Date.now());
          void queryDerivatives("takerFlow", { instId: symbol, period: takerPeriod.period, limit: 100 })
            .then((remote) => applyTaker(mergeTakerBuckets(local, parseTakerItems(remote.items))))
            .catch(() => undefined);
        }
      } else if (active) {
        const error = takerResult.reason;
        setTakerNotice(error instanceof Error ? error.message : String(error));
      }
      // 清算数据读取失败不影响其它图层。
      if (liquidationResult.status === "fulfilled") {
        const marks = parseLiquidations(liquidationResult.value.items);
        liquidationCache.set(symbol, marks);
        if (!active) return;
        primitiveRef.current?.setLiquidations(marks);
        setLiquidationCount(marks.length);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), DERIVATIVES_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [chartVersion, enabled, firstCandleTime, preview, symbol, takerPeriod.period, text]);

  // Delta 柱 + CVD 线（独立副图）与背离。
  const deltas = useMemo(
    () => (enabled ? buildDeltaSeries(taker, barSeconds, takerPeriod.seconds, firstCandleTime) : []),
    [barSeconds, enabled, firstCandleTime, taker, takerPeriod.seconds]
  );
  const divergences = useMemo(
    () => (deltas.length > 0 ? detectDivergences(candles, deltas, Math.max(barSeconds, takerPeriod.seconds)) : []),
    // 只在数据点变化时重算（最新一根的价格跳动不改变摆点）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deltas, candles.length, barSeconds, takerPeriod.seconds]
  );

  useEffect(() => {
    primitiveRef.current?.setDivergences(divergences);
  }, [divergences]);

  useEffect(() => {
    primitiveRef.current?.setDeltas(deltas, Math.max(barSeconds, takerPeriod.seconds));
  }, [barSeconds, chartVersion, deltas, takerPeriod.seconds]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!enabled || !chart || deltas.length === 0) return;
    chart.ensurePane({ id: ORDER_FLOW_PANE_ID, height: 130 });
    // Delta 柱的亮度随强度：大额主动成交一眼可见，小额噪声退到背景。
    const maxDelta = Math.max(1, ...deltas.map((point) => Math.abs(point.delta)));
    chart.setIndicatorData(
      { key: DELTA_KEY, paneId: ORDER_FLOW_PANE_ID, type: "histogram", priceLineVisible: false, lastValueVisible: false },
      deltas.map((point) => ({
        time: point.time,
        value: point.delta,
        color: `rgba(${point.delta >= 0 ? BID_RGB : ASK_RGB}, ${(0.28 + 0.67 * Math.min(1, Math.abs(point.delta) / maxDelta)).toFixed(3)})`
      }))
    );
    // CVD：以回看窗口起点为 0 的双色渐变面积，0 轴以上 = 窗口内净主动买，以下 = 净主动卖。
    chart.setIndicatorData(
      { key: CVD_KEY, paneId: ORDER_FLOW_PANE_ID, type: "baseline", color: BID_RGB, negativeColor: ASK_RGB, lineWidth: 2, priceScaleId: "orderflow-cvd-line", priceLineVisible: false, lastValueVisible: true },
      deltas.map((point) => ({ time: point.time, value: point.cvd }))
    );
  }, [chartRef, chartVersion, deltas, enabled]);

  // 关闭模式或切换图表实例时移除副图。
  useEffect(() => {
    const chart = chartRef.current;
    if (!enabled || !chart) return;
    return () => {
      chart.removeIndicator(DELTA_KEY);
      chart.removeIndicator(CVD_KEY);
      chart.removePane(ORDER_FLOW_PANE_ID);
    };
  }, [chartRef, chartVersion, enabled]);

  return {
    enabled,
    profileCoverage,
    takerPeriod: takerPeriod.period,
    takerPoints: deltas.length,
    takerNotice,
    liquidationCount,
    wallCount,
    divergenceCount: divergences.length
  };
}

export function OrderFlowLegend({ layer, text }: { layer: OrderFlowLayerState; text: UiText }) {
  if (!layer.enabled) return null;
  const coverage = layer.profileCoverage;
  const coverageLabel = coverage && coverage.expected > 0
    ? coverage.covered >= coverage.expected * 0.98
      ? text(`Profile: last ${PROFILE_LOOKBACK_BARS} bars · full 1m coverage`, `成交分布：最近 ${PROFILE_LOOKBACK_BARS} 根 · 1m 数据完整`)
      : text(`Profile: last ${PROFILE_LOOKBACK_BARS} bars · ${Math.round((coverage.covered / coverage.expected) * 100)}% of 1m bars local`, `成交分布：最近 ${PROFILE_LOOKBACK_BARS} 根 · 本地 1m 覆盖 ${Math.round((coverage.covered / coverage.expected) * 100)}%`)
    : null;
  return (
    <div
      className="chart-orderflow-legend"
      role="group"
      aria-label={text("Order flow legend", "订单流图例")}
      data-delta-points={layer.takerPoints}
      data-walls={layer.wallCount}
      data-divergences={layer.divergenceCount}
      data-liquidations={layer.liquidationCount}
    >
      <span className="chart-orderflow-legend__item" title={text("Volume split by candle direction (close ≥ open), not by taker side", "按 K 线方向（收 ≥ 开）拆分的成交量，不是逐笔主动买卖")}><i className="is-profile" />{text("Volume profile (up / down bars) · POC · value area", "成交量分布（阳 / 阴线）· POC · 价值区")}</span>
      <span className="chart-orderflow-legend__item"><i className="is-delta" />{text(`Taker delta / CVD (${layer.takerPeriod})`, `主动买卖差 / CVD（${layer.takerPeriod}）`)}</span>
      <span className="chart-orderflow-legend__item"><i className="is-wall" />{text(`Current walls ${layer.wallCount}`, `当前大单墙 ${layer.wallCount}`)}</span>
      <span className="chart-orderflow-legend__item"><i className="is-liq" />{text(`Liquidations ${layer.liquidationCount}`, `清算 ${layer.liquidationCount}`)}</span>
      {layer.divergenceCount > 0 ? <span className="chart-orderflow-legend__item"><i className="is-div" />{text(`Divergences ${layer.divergenceCount}`, `背离 ${layer.divergenceCount}`)}</span> : null}
      {coverageLabel ? <span className="chart-orderflow-legend__note">{coverageLabel}</span> : null}
      {layer.takerNotice ? <span className="chart-orderflow-legend__note is-warn">{layer.takerNotice}</span> : null}
    </div>
  );
}
