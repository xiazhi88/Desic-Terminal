import { lazy, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  BookOpen,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronRight,
  Maximize2,
  Code2,
  FileText,
  Gauge,
  History,
  Newspaper,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  WalletCards,
  X
} from "lucide-react";
import type { AiSkillDefinition, MarketAssetsSummary, MarketRadarResearchScore, Ticker } from "../types";
import {
  loadIntelligenceSummary,
  queryAnomalies,
  queryCalendar,
  queryDerivatives,
  queryNews,
  queryNewsEvents,
  querySentiment,
  querySmartMoney,
  readNewsDetail,
  queryNewsFeed,
  readNewsEvent,
  type IntelligenceRecord,
  type IntelligenceResponse,
  type IntelligenceSummary,
  type NewsFeedPage
} from "../lib/intelligence";
import { createTradingChart, type ChartCandlePoint } from "./chartAdapter";
import { useMarketHotStore } from "../lib/marketHotStore";
import { fetchCandles, fetchFundingRate, fetchTicker, loadMarketRadarResearchScores } from "../lib/okx";
import { buildMarketRadarRows } from "../lib/marketRadar";
import { isTauriRuntime } from "../lib/tauri";
import { resolvedLocale } from "../i18n/runtime";
import { IntelligenceEvidenceChart } from "./IntelligenceEvidenceChart";
import type { AiResearchArtifact } from "./AiMessageProcess";
import { safeJson } from "./AiMessageProcess";
import { SymbolIcon } from "./SymbolIcon";

const SystematicPythonEditor = lazy(() =>
  import("./SystematicPythonEditor").then((module) => ({ default: module.SystematicPythonEditor }))
);

type InspectorSection = "artifacts" | "intelligence" | "radar";
type InspectorTab = AiResearchArtifact & { closable?: boolean };
type InspectorSessionState = { tabs: InspectorTab[]; activeTabId: string; section: InspectorSection };
type RadarPanelTab = "overview" | "strength" | "movers" | "active" | "stable";
type IntelligenceTab = "news" | "sentiment" | "derivatives" | "smart" | "history";
type NewsMode = "articles" | "events";
type NewsDetail = { kind: NewsMode; record: IntelligenceRecord; loading: boolean; error?: string };

type InspectorProps = {
  sessionId: string;
  artifact?: AiResearchArtifact | null;
  selectedSymbol?: string;
  accountId?: string;
  accountLabel?: string;
  skillDefinitions?: AiSkillDefinition[];
  open: boolean;
  section?: InspectorSection;
  onSectionChange?: (section: InspectorSection) => void;
  onClose: () => void;
  onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void;
  onOpenIntelligence?: () => void;
  onOpenTrading?: () => void;
  onResearchPrompt?: (prompt: string) => void;
  onOpenMessage?: (messageId: string) => void;
  marketAssets?: MarketAssetsSummary | null;
  marketTickers?: Ticker[];
  cacheDir?: string;
  uiText: (zh: string, en: string) => string;
};

function artifactIcon(kind: AiResearchArtifact["kind"], size = 15) {
  if (kind === "strategy") return <Code2 size={size} />;
  if (kind === "skill") return <Sparkles size={size} />;
  if (kind === "market") return <BarChart3 size={size} />;
  if (kind === "intelligence") return <Search size={size} />;
  if (kind === "account") return <WalletCards size={size} />;
  if (kind === "trade") return <ShieldCheck size={size} />;
  return <FileText size={size} />;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseRecord(value: unknown) {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function numberValue(value: unknown, ...keys: string[]) {
  const source = record(value);
  for (const key of keys) {
    const raw = source[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const next = typeof raw === "number" ? raw : Number(String(raw).replaceAll(",", ""));
    if (Number.isFinite(next)) return next;
  }
  return null;
}

function formatNumber(value: unknown, digits = 2) {
  const next = typeof value === "number" ? value : Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(next) ? next.toLocaleString(undefined, { maximumFractionDigits: digits }) : "--";
}

function formatTime(value: unknown) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return "--";
  const milliseconds = next < 10_000_000_000 ? next * 1000 : next;
  return new Intl.DateTimeFormat(resolvedLocale(), { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(milliseconds));
}

function primitiveRows(value: unknown, limit = 12) {
  const source = record(value);
  return Object.entries(source)
    .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
    .slice(0, limit)
    .map(([key, item]) => [key, String(item)] as const);
}

/* 事实噪声段：任一路径分段（去 [n] 索引）命中即整键隐藏——裸 epoch、内部元数据、消息载荷本体。
   消息流侧 toolFactRows 已升级为递归扁平化路径键（ticker.last、markets[0].instId、markets 计数），
   这里按"分段"而非"整键"匹配：ticker.ageMs / result.content / source.path 等中段噪声同样滤净，
   用户在事实卡里看到的全是有意义字段。 */
const HIDDEN_FACT_KEYS = new Set([
  "ageMs", "asOf", "dataAt", "fetchedAt", "observedAt", "expectedLatestConfirmedAt", "expectedPoints",
  "seqId", "sourceEventSeqs", "content", "contentSha256", "sha256", "source", "sourceVersion",
  "modelVersion", "universeSize", "snapshotAt", "ts", "time", "confirm", "openTimeMs", "closeTimeMs"
]);

function isHiddenFactKey(key: string) {
  return key.split(/[.\[\]]+/).some((segment) => HIDDEN_FACT_KEYS.has(segment));
}

function factLabel(key: string, uiText: InspectorProps["uiText"]) {
  const labels: Record<string, [string, string]> = {
    symbol: ["交易对", "Pair"],
    instId: ["交易对", "Pair"],
    account: ["账户", "Account"],
    last: ["最新价", "Last price"],
    lastPrice: ["最新价", "Last price"],
    price: ["价格", "Price"],
    open24h: ["24h 开盘", "24h open"],
    high24h: ["24h 最高", "24h high"],
    low24h: ["24h 最低", "24h low"],
    changePct: ["涨跌幅", "Change"],
    bar: ["周期", "Interval"],
    count: ["数据量", "Samples"],
    depth: ["盘口深度", "Book depth"],
    bidTotal: ["买盘总量", "Bid volume"],
    askTotal: ["卖盘总量", "Ask volume"],
    volume: ["成交量", "Volume"],
    fundingRate: ["资金费率", "Funding rate"],
    nextFundingRate: ["预测资金费率", "Next funding"],
    basis: ["基差", "Basis"],
    latencyMs: ["延迟", "Latency"],
    markets: ["市场", "Markets"],
    summary: ["摘要", "Summary"],
    state: ["状态", "State"],
    ctVal: ["合约面值", "Contract value"],
    lever: ["杠杆", "Leverage"],
    tickSz: ["价格步长", "Tick size"],
    lotSz: ["下单步长", "Lot size"],
    settleCcy: ["结算币种", "Settlement"],
    askPx: ["卖一价", "Ask price"],
    bidPx: ["买一价", "Bid price"],
    volCcy24h: ["24h 成交量", "24h volume"],
    vol24h: ["24h 成交量", "24h volume"],
    // 路径键前缀名词与 OHLC 尾段：ticker.last → "行情 · 最新价"、instrument.ctVal → "合约规格 · 合约面值"
    ticker: ["行情", "Ticker"],
    instrument: ["合约规格", "Instrument"],
    candles: ["K 线", "Candles"],
    indicators: ["指标", "Indicators"],
    open: ["开盘价", "Open"],
    high: ["最高价", "High"],
    low: ["最低价", "Low"],
    close: ["收盘价", "Close"]
  };
  const label = labels[key];
  return label ? uiText(label[0], label[1]) : null;
}

/* 段名人类化：先查 labels 映射，未命中按 camelCase 与字母-数字边界拆词（volCcy24h → Vol Ccy 24h、ema20 → Ema 20） */
function humanizeFactSegment(segment: string, uiText: InspectorProps["uiText"]) {
  const mapped = factLabel(segment, uiText);
  if (mapped) return mapped;
  const words = segment.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* 嵌套路径键标签：segments 去索引后逐段人类化，相邻重复标签去重（fundingRate.fundingRate → 资金费率） */
function pathFactLabel(key: string, uiText: InspectorProps["uiText"]) {
  const segments = key.split(/[.\[\]]+/).filter((part) => part && !/^\d+$/.test(part));
  const rendered: string[] = [];
  for (const segment of segments) {
    const label = humanizeFactSegment(segment, uiText);
    if (rendered[rendered.length - 1] !== label) rendered.push(label);
  }
  return rendered.join(" · ");
}

/* [object Object] 兜底：上游把纯对象值 String 化后只剩不可读占位——整行丢弃；
   混有可读片段的（如 csv 中夹杂）保留原样，交给 dd 的 CSS 省略号 */
function isUnreadableFactValue(value: string) {
  return /^(?:\[object Object\][,，、]?\s*)+$/.test(value.trim());
}

function presentFactRows(rows: ReadonlyArray<readonly [string, string]>, uiText: InspectorProps["uiText"]) {
  const seen = new Set<string>();
  return rows.flatMap(([key, rawValue]) => {
    // 噪声过滤对平铺键与路径键统一生效（任一分段命中即整键隐藏）
    if (isHiddenFactKey(key)) return [];
    // 运行时兜底：数组值 → "共 N 项" 计数文案（不渲染成 [object Object]）；对象值 String 化后走占位过滤
    const raw = rawValue as unknown;
    const value = typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? uiText(`共 ${raw.length} 项`, `${raw.length} items`)
        : String(raw ?? "");
    if (isUnreadableFactValue(value)) return [];
    /* 嵌套路径键按路径人类化（消息流侧 toolFactRows 已改供扁平路径键），平铺键保持旧白名单 */
    const label = key.includes(".") || key.includes("[") ? pathFactLabel(key, uiText) : factLabel(key, uiText);
    if (!label) return [];
    const dedupeKey = `${label}:${value}`;
    if (seen.has(dedupeKey)) return [];
    seen.add(dedupeKey);
    return [[label, value] as [string, string]];
  });
}

function ArtifactFacts({ artifact, uiText }: { artifact: AiResearchArtifact; uiText: InspectorProps["uiText"] }) {
  const rows = presentFactRows(artifact.facts?.length ? artifact.facts : primitiveRows(artifact.data), uiText);
  if (rows.length === 0) return <p className="ai-inspector-empty">{uiText("暂无可固定的结构化字段。", "No stable structured fields are available.")}</p>;
  return <dl className="ai-inspector-facts">
    {rows.map(([label, value]) => <div key={`${label}:${value}`}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}
  </dl>;
}

function numericFacts(artifact: AiResearchArtifact, uiText: InspectorProps["uiText"]) {
  return presentFactRows(artifact.facts ?? primitiveRows(artifact.data, 16), uiText)
    .map(([label, value]) => ({ label, value, number: Number(value.replace(/[%,$ ]/g, "")) }))
    .filter((item) => Number.isFinite(item.number))
    .slice(0, 8);
}

function payloadSources(data: unknown) {
  const source = parseRecord(data);
  const result = parseRecord(source.result);
  return { source, result, nested: parseRecord(result.result) };
}

function artifactTitle(artifact: AiResearchArtifact, symbol: string | undefined, uiText: InspectorProps["uiText"]) {
  if (artifact.kind === "skill") return artifact.title;
  const labels: Record<string, [string, string]> = {
    "market.readCandles": ["价格历史", "Price history"],
    "market.readTicker": ["行情快照", "Market ticker"],
    "market.readOrderBook": ["订单簿", "Order book"],
    "market.readTrades": ["最新成交", "Recent trades"],
    "market.readFundingRate": ["资金费率", "Funding rate"],
    "market.readIndicators": ["技术指标", "Technical indicators"],
    "market.readInstrument": ["合约规格", "Instrument details"],
    "market.readDecisionContext": ["实时市场快照", "Live market snapshot"]
  };
  if (artifact.toolName && labels[artifact.toolName]) {
    const label = labels[artifact.toolName];
    return uiText(label[0], label[1]);
  }
  return artifact.id === "market-overview" ? `${symbol || uiText("市场", "Market")} ${uiText("行情", "overview")}` : artifact.title;
}

type ParsedCandleSeries = {
  candles: ChartCandlePoint[];
  // 是否每个点都带真实 OHLC；false 表示仅收盘价可用（稀疏序列，走"线 + 点标记"渲染）
  complete: boolean;
  // 命中的周期标签（如 "5m"），来自 bars 包装键或顶层 bar 字段
  bar: string | null;
};

function normalizeCandleTime(time: number) {
  return time < 10_000_000_000 ? time : Math.floor(time / 1000);
}

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const next = Number(value.replaceAll(",", ""));
    return Number.isFinite(next) ? next : null;
  }
  return null;
}

// 实际工具返回形状（对照 src-tauri/src/lib.rs 的 ai_read_candles / ai_read_multi_candles）：
// - 单周期调用：{ instId, bar, candles: [{ time(13 位 ms), openTimeMs, closeTimeMs, open, high, low, close, volume, confirm }] }
// - 多周期调用：{ summary: "… 已读取 N 个周期 K 线", instId, bars: { "5m": { candles: […] }, "15m": {…}, … } }
//   多周期返回的 candles 嵌在 bars.<周期> 之下，顶层没有任何候选键——旧实现只找顶层
//   candles/history/series/items，因此解析得 0 点、图表落到"单点快照"兜底，而卡片描述仍写
//   "已读取 3 个周期"，观感自相矛盾（3 指的是 3 个周期/时间框架，不是 3 根 K 线）。
//   这里做防御性多形状解析：bars 包装、OKX REST 数组行 [ts, o, h, l, c, vol]、
//   time/timestamp/ts 等键名、字符串数字，以及只有收盘价可用的稀疏行（{ time, value/close }）。
function parseCandleRow(item: unknown): { time: number; open: number | null; high: number | null; low: number | null; close: number | null } | null {
  if (Array.isArray(item)) {
    const cells = item.map(coerceFiniteNumber);
    if (cells.length >= 5 && cells[0] !== null) {
      return { time: cells[0]!, open: cells[1] ?? null, high: cells[2] ?? null, low: cells[3] ?? null, close: cells[4] ?? null };
    }
    return null;
  }
  const row = record(item);
  if (Object.keys(row).length === 0) return null;
  const time = numberValue(row, "time", "openTimeMs", "openTime", "timestamp", "ts");
  if (time === null) return null;
  return {
    time,
    open: numberValue(row, "open", "o", "openPx"),
    high: numberValue(row, "high", "h", "highPx"),
    low: numberValue(row, "low", "l", "lowPx"),
    close: numberValue(row, "close", "c", "closePx", "price", "value", "last")
  };
}

function collectCandlePoints(candidate: unknown): { candles: ChartCandlePoint[]; complete: boolean } {
  if (!Array.isArray(candidate)) return { candles: [], complete: false };
  const candles: ChartCandlePoint[] = [];
  let complete = true;
  for (const item of candidate) {
    const row = parseCandleRow(item);
    if (!row || row.close === null) {
      complete = false;
      continue;
    }
    const { time, close } = row;
    if (row.open === null || row.high === null || row.low === null) {
      // 缺 OHLC 的稀疏点：只保留收盘价，按平值占位，由图表层降级为"线 + 点标记"
      complete = false;
      candles.push({ time: normalizeCandleTime(time), open: close, high: close, low: close, close });
      continue;
    }
    candles.push({ time: normalizeCandleTime(time), open: row.open, high: row.high, low: row.low, close });
  }
  const unique = new Map(candles.map((value): [number, ChartCandlePoint] => [value.time, value]));
  return { candles: [...unique.values()].sort((left, right) => left.time - right.time), complete };
}

function parseMarketCandles(data: unknown): ParsedCandleSeries {
  const { source, result, nested } = payloadSources(data);
  // best：≥2 点的真实序列；single：仅 1 点的单点快照（保底同源展示，避免图表与计数各说各话）
  let best: ParsedCandleSeries | null = null;
  let single: ParsedCandleSeries | null = null;
  // 1) 多周期包装：bars.<bar> 下挂 candles（或直接是数组 / 再包一层 data/list）
  for (const root of [source, result, nested]) {
    for (const [bar, group] of Object.entries(record(root.bars))) {
      const groupRecord = record(group);
      const candidates = [groupRecord.candles, groupRecord.data, groupRecord.list, Array.isArray(group) ? group : null];
      for (const candidate of candidates) {
        const parsed = collectCandlePoints(candidate);
        // 多周期返回含多组序列：一张图画同一条周期序列才诚实——取样本最多的一组，
        // 其余周期组保留在"原始数据"里可查
        if (parsed.candles.length >= 2 && (!best || parsed.candles.length > best.candles.length)) {
          best = { ...parsed, bar };
        }
        if (parsed.candles.length === 1 && !single) {
          single = { ...parsed, bar };
        }
      }
    }
  }
  if (best) return best;
  // 2) 顶层别名键（旧单周期形状与第三方包装）
  for (const root of [source, result, nested]) {
    for (const key of ["candles", "history", "series", "items", "data", "list"]) {
      const parsed = collectCandlePoints(root[key]);
      if (parsed.candles.length >= 2) return { ...parsed, bar: text(root.bar) || null };
      if (parsed.candles.length === 1 && !single) {
        single = { ...parsed, bar: text(root.bar) || null };
      }
    }
  }
  if (single) return single;
  return { candles: [], complete: true, bar: text(source.bar) || text(result.bar) || null };
}

// —— 图表悬停公共件（问题 A）——
// 客户端坐标 → SVG viewBox 坐标（getScreenCTM 自带等比缩放与 letterbox 平移，无需手算）。
function svgChartPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM();
  if (!ctm || !ctm.a || !ctm.d) return null;
  return { x: (clientX - ctm.e) / ctm.a, y: (clientY - ctm.f) / ctm.d };
}

// 指标/深度等序列数值的紧凑格式：量级决定小数位，保证 tooltip 与徽标宽度稳定。
function formatSeriesValue(value: number) {
  const abs = Math.abs(value);
  const digits = abs >= 100_000 ? 0 : abs >= 1_000 ? 1 : abs >= 1 ? 2 : 4;
  return formatNumber(value, digits);
}

type ChartTooltipRow = { label: string; value: string; color?: string };

// 浮动 tooltip：绝对定位在悬停热区内，靠近右缘时翻转（translateX(-100%)）。
// left 用 clamp 按热区实际像素宽封边：普通态右缘不越界，翻转态左缘不越界，绝不溢出容器；
// 出现不做动画（纯 opacity ≤120ms 由 CSS 控制），且 pointer-events: none 不挡指针。
function ChartTooltip({ x, width, zoneWidth, title, rows }: { x: number; width: number; zoneWidth: number; title: string; rows: ChartTooltipRow[] }) {
  const ratio = Math.min(1, Math.max(0, x / width));
  const px = ratio * zoneWidth;
  const flip = px > zoneWidth - 180;
  const left = flip
    ? `clamp(180px, ${px}px, 100%)`
    : `clamp(0px, ${px}px, calc(100% - 180px))`;
  return <div className={`ai-chart-tooltip${flip ? " flip" : ""}`} style={{ left }} aria-hidden="true">
    {/* 纯视觉重复信息且随 pointermove 高频重渲染，对读屏隐藏，避免 live region 刷屏 */}
    <div className="ai-chart-tooltip-head">{title}</div>
    {rows.map((row) => <div className="ai-chart-tooltip-row" key={row.label}>{row.color ? <i style={{ background: row.color }} /> : null}<span>{row.label}</span><b>{row.value}</b></div>)}
  </div>;
}

function MarketKlineChart({ candles, uiText, complete = true, bar = null }: { candles: ChartCandlePoint[]; uiText: InspectorProps["uiText"]; complete?: boolean; bar?: string | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof createTradingChart> | null>(null);
  const [hoverCandle, setHoverCandle] = useState<ChartCandlePoint | null>(null);
  const candleByTime = useMemo(() => new Map(candles.map((item): [number, ChartCandlePoint] => [item.time, item])), [candles]);
  // ≥5 点且 OHLC 完整 → 图表库蜡烛图；否则（2-4 点或仅收盘价）→ 稀疏 SVG 线 + 点标记
  const useLibraryChart = complete && candles.length >= 5;
  useEffect(() => {
    if (!hostRef.current || !useLibraryChart) return;
    const chart = createTradingChart(hostRef.current, []);
    chartRef.current = chart;
    chart.setCandles(candles);
    chart.fitContent();
    // 悬停联动：图表库十字线落在某根 K 线上时，头部 OHLC 读数切到该根；离开恢复最新一根
    const offCrosshair = chart.onCrosshairMove((position) => {
      setHoverCandle(position ? candleByTime.get(position.time) ?? null : null);
    });
    return () => {
      offCrosshair();
      chart.destroy();
      chartRef.current = null;
    };
  }, [candles, candleByTime, useLibraryChart]);
  if (candles.length === 0) return <div className="ai-market-chart-empty">{uiText("当前工具返回单点快照，暂无 K 线序列。", "This tool returned a snapshot without a K-line series.")}</div>;
  if (candles.length === 1) {
    // 单点快照：文案与外层"已读取 N"同源（同一解析结果），保留原文案并附快照值
    const only = candles[0]!;
    return <div className="ai-market-chart-empty">{uiText("当前工具返回单点快照，暂无 K 线序列。", "This tool returned a snapshot without a K-line series.")}<small>{uiText("快照", "Snapshot")} · {formatTime(only.time * 1000)} · {uiText("收盘", "close")} {formatNumber(only.close)}</small></div>;
  }
  if (!useLibraryChart) return <KlineSparkline candles={candles} complete={complete} bar={bar} uiText={uiText} />;
  const latest = candles.at(-1)!;
  const shown = hoverCandle ?? latest;
  const up = shown.close >= shown.open;
  const change = latest.open ? ((latest.close - latest.open) / latest.open) * 100 : 0;
  return <section className="ai-market-kline" aria-label={uiText("K 线图", "Candlestick chart")}>
    <div className="ai-market-chart-head"><strong><ChartNoAxesCombined size={13} />{uiText("K 线图", "Candles")}</strong><small>{bar ? `${bar} · ` : ""}{candles.length} {uiText("根", "bars")} · {formatTime(latest.time * 1000)} · <b className={change >= 0 ? "positive" : "negative"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</b></small></div>
    <div className="ai-market-kline-ohlc" aria-label={uiText("K 线读数", "Candle readout")}>
      <span>{uiText("开", "O")} <b>{formatNumber(shown.open)}</b></span>
      <span>{uiText("高", "H")} <b>{formatNumber(shown.high)}</b></span>
      <span>{uiText("低", "L")} <b>{formatNumber(shown.low)}</b></span>
      <span>{uiText("收", "C")} <b className={up ? "positive" : "negative"}>{formatNumber(shown.close)}</b></span>
      <span>{formatTime(shown.time * 1000)}</span>
    </div>
    <div className="ai-market-kline-canvas" ref={hostRef} />
  </section>;
}

// 稀疏 K 线（2-4 点，或仅收盘价可用）：SVG 折线 + 点标记 + 悬停十字线/tooltip，
// 不启用图表库——2 根蜡烛没有结构信息，连线更能表达"序列"本身。
function KlineSparkline({ candles, complete, bar, uiText }: { candles: ChartCandlePoint[]; complete: boolean; bar: string | null; uiText: InspectorProps["uiText"] }) {
  const width = 520;
  const height = 180;
  const padX = 16;
  const padT = 18;
  const padB = 16;
  const [hover, setHover] = useState<{ index: number; x: number; zone: number } | null>(null);
  const closes = candles.map((item) => item.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || Math.abs(max) || 1;
  const xFor = (index: number) => padX + (index / Math.max(candles.length - 1, 1)) * (width - padX * 2);
  const yFor = (value: number) => height - padB - ((value - min) / span) * (height - padT - padB);
  const latest = candles.at(-1)!;
  const change = latest.open ? ((latest.close - latest.open) / latest.open) * 100 : 0;
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = svgChartPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const ratio = (point.x - padX) / (width - padX * 2);
    const index = Math.round(Math.min(1, Math.max(0, ratio)) * (candles.length - 1));
    setHover({ index, x: Math.min(width - padX, Math.max(padX, point.x)), zone: event.currentTarget.getBoundingClientRect().width || width });
  };
  const hovered = hover ? candles[hover.index] ?? null : null;
  const rows: ChartTooltipRow[] = hovered ? (complete
    ? [
      { label: uiText("开", "O"), value: formatNumber(hovered.open) },
      { label: uiText("高", "H"), value: formatNumber(hovered.high) },
      { label: uiText("低", "L"), value: formatNumber(hovered.low) },
      { label: uiText("收", "C"), value: formatNumber(hovered.close) }
    ]
    : [{ label: uiText("收盘", "Close"), value: formatNumber(hovered.close) }])
    : [];
  return <section className="ai-market-kline" aria-label={uiText("K 线图", "Candlestick chart")}>
    <div className="ai-market-chart-head"><strong><ChartNoAxesCombined size={13} />{uiText("K 线图", "Candles")}</strong><small>{bar ? `${bar} · ` : ""}{candles.length} {uiText("点", "points")} · {formatTime(latest.time * 1000)} · <b className={change >= 0 ? "positive" : "negative"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</b></small></div>
    <div className="ai-chart-hover-zone">
      <svg className="ai-market-kline-spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={uiText("价格序列图", "Price series chart")} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)}>
        <path d={`M ${padX} ${padT} H ${width - padX} M ${padX} ${(padT + height - padB) / 2} H ${width - padX} M ${padX} ${height - padB} H ${width - padX}`} className="ai-market-chart-grid" />
        <polyline className="ai-market-kline-spark-line" points={candles.map((item, index) => `${xFor(index)},${yFor(item.close)}`).join(" ")} />
        {candles.map((item, index) => <circle key={item.time} className={hover?.index === index ? "ai-market-kline-spark-dot hot" : "ai-market-kline-spark-dot"} cx={xFor(index)} cy={yFor(item.close)} r={hover?.index === index ? 4.5 : 3.2} />)}
        {hover ? <line className="ai-chart-crosshair" x1={hover.x} x2={hover.x} y1={padT} y2={height - padB} /> : null}
      </svg>
      {hovered ? <ChartTooltip x={hover!.x} width={width} zoneWidth={hover!.zone} title={formatTime(hovered.time * 1000)} rows={rows} /> : null}
    </div>
  </section>;
}

type MiniLineSeries = { label: string; values: Array<number | null>; color: string };

// 指标值序列：保留 null（预热期）占位。Rust 端每条指标序列与 K 线窗口同长、前段为 null
// （如 ema20 前 19 根），旧实现把 null 剔除会让各序列长度错位、悬停索引对不齐；
// 保留占位后所有序列样本一一对应，预热段自然留白，对数据更诚实。
function indicatorValues(value: unknown): Array<number | null> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    return numberValue(item, "value", "v", "close", "price");
  });
}

function indicatorSeries(data: unknown): MiniLineSeries[] {
  const { source, result, nested } = payloadSources(data);
  // 指标容器的值可能是数组（ema/rsi/atr/sma）或"数组对象"（boll: {upper,middle,lower}、macd: {macd,signal,histogram}）
  const hasSeriesShape = (value: unknown) => Array.isArray(value) || Object.values(record(value)).some(Array.isArray);
  const container = [source.indicators, result.indicators, nested.indicators, source.series, result.series].map(record).find((item) => Object.values(item).some(hasSeriesShape));
  if (!container) return [];
  const colors = ["#67d6bd", "#e2a35d", "#9b8af4", "#5eb9e8", "#e87d91"];
  let colorIndex = 0;
  return Object.entries(container).flatMap(([label, value]) => {
    const groups: Array<[string, unknown]> = Array.isArray(value) ? [["", value]] : Object.entries(record(value)).filter(([, item]) => Array.isArray(item));
    return groups.flatMap(([suffix, raw]) => {
      const values = indicatorValues(raw);
      if (values.filter((item) => item !== null).length < 3) return [];
      const color = colors[colorIndex % colors.length];
      colorIndex += 1;
      return [{ label: suffix ? `${label}.${suffix}` : label, values: values.slice(-160), color }];
    });
  }).slice(0, 5);
}

// 归一化取舍：真实指标序列量纲差异极大（EMA≈6.3e4、ATR≈5e2、RSI∈[0,100]）。若共享同一
// 0-1 值域，ATR/RSI 会被 EMA 压成两条贴底平线（实机截图问题），读不出任何形状；改成
// "每序列独立 min-max"缩放到同一绘图框——只保证各序列自身走势可读，不承诺跨序列纵向
// 位置可比；真实数值差异由悬停 tooltip 与右侧最新值徽标呈现。这是对当前数据最诚实的折中。
function MarketIndicatorChart({ data, uiText }: { data: unknown; uiText: InspectorProps["uiText"] }) {
  const series = indicatorSeries(data);
  const [hover, setHover] = useState<{ index: number; x: number; zone: number; nearest: string } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  if (series.length === 0) return null;
  const width = 520;
  const height = 180;
  const padX = 12;
  const padT = 18;
  const padB = 16;
  const innerW = width - padX * 2;
  const innerH = height - padT - padB;
  const scales = series.map((item) => {
    const present = item.values.filter((value): value is number => value !== null);
    const min = Math.min(...present);
    const max = Math.max(...present);
    return { min, max, span: max - min || Math.abs(max) || 1 };
  });
  const xFor = (index: number, length: number) => padX + (index / Math.max(length - 1, 1)) * innerW;
  const yFor = (value: number, scaleIndex: number) => {
    const scale = scales[scaleIndex]!;
    return height - padB - ((value - scale.min) / scale.span) * innerH;
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = svgChartPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const count = series[0]!.values.length;
    const index = Math.round(Math.min(1, Math.max(0, (point.x - padX) / innerW)) * (count - 1));
    // 图例联动：把十字线"最近"的序列记下来，图例对应项高亮
    let nearest = series[0]!.label;
    let bestDist = Number.POSITIVE_INFINITY;
    series.forEach((item, itemIndex) => {
      const value = item.values[index];
      if (value === null || value === undefined) return;
      const distance = Math.abs(yFor(value, itemIndex) - point.y);
      if (distance < bestDist) {
        bestDist = distance;
        nearest = item.label;
      }
    });
    setHover({ index, x: Math.min(width - padX, Math.max(padX, point.x)), zone: event.currentTarget.getBoundingClientRect().width || width, nearest });
  };
  const valueAt = (item: MiniLineSeries, index: number) => index < item.values.length ? item.values[index] ?? null : null;
  const hoverRows: ChartTooltipRow[] = hover ? series.map((item) => {
    const value = valueAt(item, hover.index);
    return { label: item.label, value: value === null ? "--" : formatSeriesValue(value), color: item.color };
  }) : [];
  return <section className="ai-market-linechart" aria-label={uiText("指标走势", "Indicator trends")}>
    <header><strong>{uiText("指标走势", "Indicator trends")}</strong><small>{uiText("各序列独立标度 · 悬停查看真实数值", "Per-series scale · hover for real values")}</small></header>
    <div className="ai-market-chart-body">
      <div className="ai-chart-hover-zone">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={uiText("技术指标折线图", "Technical indicator line chart")} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)}>
          <path d={[padT, padT + innerH / 3, padT + (innerH * 2) / 3, height - padB].map((y) => `M ${padX} ${y} H ${width - padX}`).join(" ")} className="ai-market-chart-grid" />
          {series.map((item, itemIndex) => <polyline
            key={item.label}
            className={`${focus && focus !== item.label ? " dim" : ""}${hover?.nearest === item.label ? " hot" : ""}`.trim() || undefined}
            points={item.values.map((value, index) => value === null ? null : `${xFor(index, item.values.length)},${yFor(value, itemIndex)}`).filter((point): point is string => point !== null).join(" ")}
            fill="none"
            stroke={item.color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round" />)}
          {hover ? <>
            <line className="ai-chart-crosshair" x1={hover.x} x2={hover.x} y1={padT} y2={height - padB} />
            {series.map((item, itemIndex) => {
              const value = valueAt(item, hover.index);
              return value === null ? null : <circle key={item.label} cx={xFor(hover.index, item.values.length)} cy={yFor(value, itemIndex)} r="3.2" fill={item.color} />;
            })}
          </> : null}
        </svg>
        {hover ? <ChartTooltip x={hover.x} width={width} zoneWidth={hover.zone} title={uiText(`样本 #${hover.index + 1}`, `Sample #${hover.index + 1}`)} rows={hoverRows} /> : null}
      </div>
      <div className="ai-market-series-badges">
        {series.map((item) => {
          const latest = [...item.values].reverse().find((value) => value !== null) ?? null;
          return <span className="ai-market-series-badge" key={item.label}><i style={{ background: item.color }} /><b>{latest === null ? "--" : formatSeriesValue(latest)}</b></span>;
        })}
      </div>
    </div>
    <div className="ai-market-chart-legend">
      {series.map((item) => <span
        key={item.label}
        className={`${focus === item.label ? "focus " : ""}${hover?.nearest === item.label ? "hot" : ""}`.trim() || undefined}
        onMouseEnter={() => setFocus(item.label)}
        onMouseLeave={() => setFocus(null)}
        onClick={() => setFocus((current) => (current === item.label ? null : item.label))}><i style={{ background: item.color }} />{item.label}</span>)}
    </div>
  </section>;
}

function MarketDepthChart({ data, uiText }: { data: unknown; uiText: InspectorProps["uiText"] }) {
  const [hover, setHover] = useState<{ x: number; side: "bid" | "ask"; index: number; zone: number } | null>(null);
  const { source, result, nested } = payloadSources(data);
  const bidsRaw = [source.bids, result.bids, nested.bids].find(Array.isArray) ?? [];
  const asksRaw = [source.asks, result.asks, nested.asks].find(Array.isArray) ?? [];
  const parse = (items: unknown[], descending: boolean) => items.map((item) => { const row = record(item); return { price: numberValue(row, "px", "price"), size: numberValue(row, "sz", "size", "quantity") }; }).filter((item): item is { price: number; size: number } => item.price !== null && item.size !== null).sort((a, b) => descending ? b.price - a.price : a.price - b.price).slice(0, 20);
  const bids = parse(bidsRaw, true);
  const asks = parse(asksRaw, false);
  if (bids.length === 0 && asks.length === 0) return null;
  const cumulative = (items: Array<{ price: number; size: number }>) => { let total = 0; return items.map((item) => { total += item.size; return { ...item, total }; }); };
  const bidPoints = cumulative(bids);
  const askPoints = cumulative(asks);
  const max = Math.max(1, ...bidPoints.map((item) => item.total), ...askPoints.map((item) => item.total));
  const point = (item: { total: number }, index: number, length: number, direction: -1 | 1) => `${260 + direction * (index / Math.max(length - 1, 1)) * 248},${158 - item.total / max * 125}`;
  const area = (items: Array<{ total: number }>, direction: -1 | 1) => items.length === 0 ? "" : `M 260 158 L ${items.map((item, index) => point(item, index, items.length, direction)).join(" L ")} L 260 158 Z`;
  // 悬停：中线左侧取买盘档位、右侧取卖盘档位（按 x 最近对齐），tooltip 显示价位/累计/本档
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = svgChartPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const x = Math.min(508, Math.max(12, point.x));
    const bidIndex = Math.round(Math.min(1, Math.max(0, (260 - x) / 248)) * Math.max(bidPoints.length - 1, 0));
    const askIndex = Math.round(Math.min(1, Math.max(0, (x - 260) / 248)) * Math.max(askPoints.length - 1, 0));
    if (x <= 260) {
      if (bidPoints.length === 0) return;
      setHover({ x, side: "bid", index: bidIndex, zone: event.currentTarget.getBoundingClientRect().width || 520 });
    } else {
      if (askPoints.length === 0) return;
      setHover({ x, side: "ask", index: askIndex, zone: event.currentTarget.getBoundingClientRect().width || 520 });
    }
  };
  const hoverPoint = hover ? (hover.side === "bid" ? bidPoints[hover.index] : askPoints[hover.index]) ?? null : null;
  const hoverRows: ChartTooltipRow[] = hoverPoint ? [
    { label: uiText("价位", "Price"), value: formatNumber(hoverPoint.price) },
    { label: uiText("累计", "Cumulative"), value: formatNumber(hoverPoint.total) },
    { label: uiText("本档", "Level"), value: formatNumber(hoverPoint.size) }
  ] : [];
  const hoverMarker = hoverPoint && hover ? {
    cx: hover.side === "bid"
      ? 260 - (hover.index / Math.max(bidPoints.length - 1, 1)) * 248
      : 260 + (hover.index / Math.max(askPoints.length - 1, 1)) * 248,
    cy: 158 - hoverPoint.total / max * 125
  } : null;
  return <section className="ai-market-depth" aria-label={uiText("盘口深度图", "Order book depth chart")}><header><strong>{uiText("盘口深度", "Order book depth")}</strong><small>{uiText("累计挂单量", "Cumulative resting size")}</small></header><div className="ai-chart-hover-zone"><svg viewBox="0 0 520 180" role="img" aria-label={uiText("买卖盘深度图", "Bid and ask depth chart")} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)}><path d="M 12 32 H 508 M 12 95 H 508 M 12 158 H 508" className="ai-market-chart-grid" />{bidPoints.length > 0 ? <><path d={area(bidPoints, -1)} fill="rgba(76, 201, 160, .16)" /><polyline points={bidPoints.map((item, index) => point(item, index, bidPoints.length, -1)).join(" ")} fill="none" stroke="#4cc9a0" strokeWidth="2.5" strokeLinejoin="round" /></> : null}{askPoints.length > 0 ? <><path d={area(askPoints, 1)} fill="rgba(232, 125, 145, .16)" /><polyline points={askPoints.map((item, index) => point(item, index, askPoints.length, 1)).join(" ")} fill="none" stroke="#e87d91" strokeWidth="2.5" strokeLinejoin="round" /></> : null}<path d="M 260 20 V 164" className="ai-market-depth-mid" /><path d="M 12 158 H 508" className="ai-market-depth-base" />{hover ? <line className="ai-chart-crosshair" x1={hover.x} x2={hover.x} y1={20} y2={164} /> : null}{hoverMarker ? <circle cx={hoverMarker.cx} cy={hoverMarker.cy} r="3.6" className={hover?.side === "bid" ? "ai-market-depth-marker bid" : "ai-market-depth-marker ask"} /> : null}</svg>{hover && hoverPoint ? <ChartTooltip x={hover.x} width={520} zoneWidth={hover.zone} title={hover.side === "bid" ? uiText("买盘", "Bids") : uiText("卖盘", "Asks")} rows={hoverRows} /> : null}</div><div className="ai-market-chart-legend"><span><i className="bid" />{uiText("买盘", "Bids")}</span><span><i className="ask" />{uiText("卖盘", "Asks")}</span></div></section>;
}

// 情绪条悬停数值反馈：行内 em 常显百分比，原生 title 再补"看多占比 + 提及数"细节
function sentimentRowTitle(item: IntelligenceRecord, uiText: InspectorProps["uiText"]) {
  const coin = String(valueFrom(item, "ccy", "coin", "symbol"));
  const ratio = (numberValue(item, "bullishRatio", "longRatio", "positiveRatio") ?? 0) * 100;
  const mentions = numberValue(item, "mentionCount", "mentions");
  return `${coin} · ${uiText("看多占比", "Bullish")} ${ratio.toFixed(1)}%${mentions !== null ? ` · ${formatNumber(mentions, 0)} ${uiText("条提及", "mentions")}` : ""}`;
}

function MarketOverviewDashboard({ symbol, onOpenTrading, uiText }: { symbol?: string; onOpenTrading?: () => void; uiText: InspectorProps["uiText"] }) {
  const hot = useMarketHotStore();
  const [summary, setSummary] = useState<IntelligenceSummary | null>(null);
  const [fallbackTicker, setFallbackTicker] = useState<typeof hot.ticker>(null);
  const [fallbackCandles, setFallbackCandles] = useState<typeof hot.candles>([]);
  const [fallbackFunding, setFallbackFunding] = useState<typeof hot.fundingRate>(null);
  useEffect(() => {
    let active = true;
    void loadIntelligenceSummary().then((next) => { if (active) setSummary(next); });
    if (isTauriRuntime() && symbol) {
      void Promise.all([fetchTicker(symbol).catch(() => null), fetchCandles(symbol, "1H", 100).catch(() => []), fetchFundingRate(symbol).catch(() => null)]).then(([nextTicker, nextCandles, nextFunding]) => {
        if (!active) return;
        if (nextTicker) setFallbackTicker(nextTicker);
        if (nextCandles.length > 0) setFallbackCandles(nextCandles);
        if (nextFunding) setFallbackFunding(nextFunding);
      });
    }
    return () => { active = false; };
  }, [symbol]);
  const ticker = hot.ticker?.instId === symbol ? hot.ticker : fallbackTicker;
  const liveCandles = hot.candleSeriesKey?.startsWith(`${symbol || ""}\u0000`) ? hot.candles : fallbackCandles;
  const candles = useMemo(() => liveCandles.map((item) => ({ time: item.time < 10_000_000_000 ? item.time : Math.floor(item.time / 1000), open: item.open, high: item.high, low: item.low, close: item.close })), [liveCandles]);
  const funding = hot.fundingRate ?? fallbackFunding;
  const bid = numberValue(ticker, "bidPx");
  const ask = numberValue(ticker, "askPx");
  const sentiment = (summary?.sentimentRankings ?? []).filter((item) => text(valueFrom(item, "ccy", "coin", "symbol")).toUpperCase() === (symbol || "BTC").split("-")[0]).slice(0, 3);
  const bidTotal = hot.book?.bids.reduce((total, item) => total + (Number(item.sz) || 0), 0) ?? 0;
  const askTotal = hot.book?.asks.reduce((total, item) => total + (Number(item.sz) || 0), 0) ?? 0;
  const change = ticker && Number.isFinite(Number(ticker.last)) && Number(ticker.open24h) ? ((Number(ticker.last) - Number(ticker.open24h)) / Number(ticker.open24h)) * 100 : null;
  return <section className="ai-market-overview" aria-label={uiText("市场概览", "Market overview")}><div className="ai-market-overview-head"><div><strong>{uiText("实时市场概览", "Live market overview")}</strong><small>{uiText("来自当前市场流与本地情报缓存", "Current market stream and local intelligence cache")}</small></div><div className="ai-market-overview-actions"><span className={change !== null && change >= 0 ? "positive" : "negative"}>{change === null ? "--" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span><button type="button" className="ai-market-open-trading" onClick={onOpenTrading} disabled={!onOpenTrading} title={uiText("打开交易面板", "Open Trading workspace")} aria-label={uiText("打开交易面板", "Open Trading workspace")}><ChartNoAxesCombined size={16} /></button></div></div><div className="ai-market-metric-grid"><div className="ai-market-metric"><small>{uiText("最新价", "Last price")}</small><strong>{ticker?.last || "--"}</strong></div><div className="ai-market-metric"><small>{uiText("买一 / 卖一", "Best bid / ask")}</small><strong>{bid === null || ask === null ? "--" : `${formatNumber(bid)} / ${formatNumber(ask)}`}</strong></div><div className="ai-market-metric"><small>{uiText("盘口买 / 卖", "Book bid / ask")}</small><strong>{`${formatNumber(bidTotal)} / ${formatNumber(askTotal)}`}</strong></div><div className="ai-market-metric"><small>{uiText("资金费率", "Funding rate")}</small><strong>{formatNumber(funding?.fundingRate, 5)}</strong></div></div>{candles.length >= 2 ? <MarketKlineChart candles={candles} uiText={uiText} /> : <div className="ai-market-chart-empty">{uiText("等待当前交易对的 K 线流…", "Waiting for the selected pair's candle stream…")}</div>}{hot.book ? <MarketDepthChart data={hot.book} uiText={uiText} /> : null}<div className="ai-market-sentiment"><header><strong>{uiText("市场情绪", "Market sentiment")}</strong><small>{uiText("本地 24h 样本", "Local 24h sample")}</small></header>{sentiment.length > 0 ? sentiment.map((item, index) => <div key={`${String(valueFrom(item, "ccy", "coin", "symbol"))}:${index}`} title={sentimentRowTitle(item, uiText)}><b>{String(valueFrom(item, "ccy", "coin", "symbol"))}</b><span><i style={{ width: `${Math.max(4, Math.min(100, (numberValue(item, "bullishRatio", "longRatio", "positiveRatio") ?? 0) * 100))}%` }} /></span><em>{formatNumber((numberValue(item, "bullishRatio", "longRatio", "positiveRatio") ?? 0) * 100, 1)}%</em></div>) : <p>{uiText("本地情绪数据尚未采集。", "Local sentiment data is not collected yet.")}</p>}</div></section>;
}

function MarketArtifact({ artifact, symbol, onOpenTrading, uiText }: { artifact: AiResearchArtifact; symbol?: string; onOpenTrading?: () => void; uiText: InspectorProps["uiText"] }) {
  const metrics = numericFacts(artifact, uiText);
  // 唯一解析入口：图表 / 计数 / 快照判定全部由这一个结果派生，杜绝"已读取 N"与"单点快照"自相矛盾
  const parsedCandles = useMemo(() => parseMarketCandles(artifact.data), [artifact.data]);
  const candles = parsedCandles.candles;
  const isOverview = artifact.id === "market-overview";
  const isCandles = artifact.toolName === "market.readCandles" || candles.length >= 2;
  const hasSeries = candles.length >= 2;
  const title = artifactTitle(artifact, symbol, uiText);
  // 解析确实只剩 1 个点时：卡片描述同步为 1（同源派生），原始工具 summary 保留在 title 里可查
  const snapshot = candles.length === 1 ? candles[0]! : null;
  const summaryLine = snapshot
    ? uiText(`已读取 1 个快照点 · ${formatTime(snapshot.time * 1000)} · 收盘 ${formatNumber(snapshot.close)}`, `Parsed 1 snapshot point · ${formatTime(snapshot.time * 1000)} · close ${formatNumber(snapshot.close)}`)
    : artifact.summary || uiText("市场工具返回的实时证据与可读指标。", "Readable evidence and metrics returned by the market tool.");
  return <div className="ai-inspector-content ai-market-artifact">
    <div className="ai-inspector-kicker">{isCandles ? uiText("K 线市场工作台", "CANDLE WORKSPACE") : uiText("市场数据工作台", "MARKET DATA WORKSPACE")}</div>
    <div className="ai-market-title-row"><div><h2>{title || symbol || uiText("市场概览", "Market overview")}</h2><small>{isOverview ? uiText("实时流 · 情报缓存", "Live stream · intelligence cache") : hasSeries ? uiText("返回数据 · OHLC 结构", "Returned data · OHLC structure") : uiText("返回数据 · 可引用快照", "Returned data · attributable snapshot")}</small></div><BarChart3 size={18} /></div>
    <p title={snapshot ? artifact.summary : undefined}>{summaryLine}</p>
    {isOverview ? <MarketOverviewDashboard symbol={symbol} onOpenTrading={onOpenTrading} uiText={uiText} /> : null}
    {!isOverview && isCandles ? <MarketKlineChart candles={candles} complete={parsedCandles.complete} bar={parsedCandles.bar} uiText={uiText} /> : null}
    {!isOverview && artifact.toolName === "market.readIndicators" ? <MarketIndicatorChart data={artifact.data} uiText={uiText} /> : null}
    {!isOverview && artifact.toolName === "market.readOrderBook" ? <MarketDepthChart data={artifact.data} uiText={uiText} /> : null}
    {!isOverview && metrics.length > 0 ? <section className="ai-market-dashboard" aria-label={uiText("市场统计", "Market statistics")}><div className="ai-market-metric-grid">{metrics.slice(0, 4).map((item) => <div className="ai-market-metric" key={item.label}><small>{item.label}</small><strong>{item.value}</strong></div>)}</div></section> : null}
    <ArtifactFacts artifact={artifact} uiText={uiText} />
    <details className="ai-inspector-raw"><summary>{uiText("查看原始数据", "View raw data")}</summary><pre>{safeJson(artifact.data)}</pre></details>
  </div>;
}

function skillPayload(data: unknown, definitions: AiSkillDefinition[]) {
  const { source, result, nested } = payloadSources(data);
  const input = record(source.input);
  const primitiveId = text(source.skill) || text(source.skillId) || text(input.skill) || text(input.skillId) || text(result.skill) || text(result.skillId) || text(nested.skillId);
  const configured = definitions.find((item) => item.id === primitiveId || item.name === primitiveId);
  const candidates: Array<Record<string, unknown>> = [configured, source.skill, source.skillId, input, source.definition, source.data, result.skill, result.definition, result.data, nested, result, source]
    .map(record)
    .filter((candidate) => Object.keys(candidate).length > 0);
  const primary = candidates.find((candidate) => ["name", "skillName", "id", "content", "rules", "instructions", "description", "resources", "files"].some((key) => key in candidate)) ?? {};
  const first = record([source.skills, source.items, result.skills, result.items].find(Array.isArray)?.[0]);
  const merged: Record<string, unknown> = { ...record(configured), ...first, ...primary };
  const content = [text(merged.rules), text(merged.content), text(merged.instructions), text(merged.body), text(merged.markdown)].filter(Boolean).join("\n\n");
  const resources: unknown[] = Array.isArray(merged.resources) ? merged.resources : Array.isArray(merged.files) ? merged.files : [];
  return {
    id: text(merged.id) || primitiveId,
    name: text(merged.name) || text(merged.skillName) || primitiveId || "Skill",
    description: text(merged.description) || text(merged.summary),
    version: text(merged.version),
    content,
    resources
  };
}

function SkillArtifact({ artifact, definitions, uiText }: { artifact: AiResearchArtifact; definitions: AiSkillDefinition[]; uiText: InspectorProps["uiText"] }) {
  const skill = skillPayload(artifact.data, definitions);
  return <div className="ai-inspector-content ai-inspector-skill">
    <div className="ai-inspector-kicker">{uiText("Skill 详情", "SKILL DETAIL")}</div>
    <div className="ai-skill-title-row"><div><h2>{skill.name || artifact.title}</h2>{skill.version ? <small>v{skill.version}</small> : null}</div><Sparkles size={18} /></div>
    <p>{skill.description || artifact.summary || uiText("此处显示当前 Skill 的适用范围与执行规则。", "Review the loaded Skill scope and execution rules here.")}</p>
    {skill.content ? <section className="ai-skill-rules"><h3>{uiText("规则与说明", "Rules and instructions")}</h3><pre className="ai-inspector-document">{skill.content}</pre></section> : <p className="ai-inspector-empty">{uiText("该 Skill 返回未包含规则正文，且当前配置没有可回填的 definition。", "This Skill returned no rule text and has no configured definition to fill it in.")}</p>}
    {skill.resources.length > 0 ? <section className="ai-skill-resources"><h3>{uiText("资源", "Resources")}</h3><ul>{skill.resources.slice(0, 12).map((item, index) => <li key={`${String(item)}:${index}`}>{typeof item === "string" ? item : text(record(item).name) || text(record(item).path) || safeJson(item)}</li>)}</ul></section> : null}
    <ArtifactFacts artifact={artifact} uiText={uiText} />
    <details className="ai-inspector-raw"><summary>{uiText("原始 Skill 载荷", "Raw Skill payload")}</summary><pre>{safeJson(artifact.data)}</pre></details>
  </div>;
}

function strategySource(data: unknown) {
  // Persisted strategy.create responses keep source in strategy.definition.source.
  const root = record(data);
  const strategy = record(root.strategy);
  const definition = record(strategy.definition);
  const version = record(root.version);
  return text(root.source)
    || text(root.code)
    || text(definition.source)
    || text(version.source)
    || text(strategy.source)
    || text(record(root.result).source)
    || text(record(record(root.result).strategy).source);
}

function strategyPlan(data: unknown) {
  const root = record(data);
  const strategy = record(root.strategy);
  const definition = record(strategy.definition);
  return {
    description: text(strategy.description) || text(root.description),
    entrypoint: text(definition.entrypoint) || "on_bar",
    protocol: text(definition.protocol) || text(root.protocolVersion),
    version: Number(strategy.version ?? root.createdVersion ?? 0) || null
  };
}

function StrategyArtifact({ artifact, onOpenStrategy, uiText }: { artifact: AiResearchArtifact; onOpenStrategy?: InspectorProps["onOpenStrategy"]; uiText: InspectorProps["uiText"] }) {
  const source = strategySource(artifact.data);
  const plan = strategyPlan(artifact.data);
  return <div className="ai-inspector-content ai-inspector-strategy">
    <div className="ai-inspector-kicker">{uiText("策略工作区", "STRATEGY WORKSPACE")}</div>
    <div className="ai-inspector-strategy-head"><div><h2>{artifact.title}</h2><small>{source ? uiText("已返回可读 Python 源码 · 只读预览", "Readable Python source returned · read-only preview") : uiText("未返回源码正文", "No source body returned")}</small></div><Code2 size={18} /></div>
    <p>{artifact.summary || uiText("此处显示本次工具返回的策略定义。编辑和保存仍在策略工作台中完成。", "This panel shows the strategy returned by the tool. Editing and saving remain in Strategy Lab.")}</p>
    <section className="ai-strategy-plan" aria-label={uiText("策略方案", "Strategy plan")}>
      <div><small>{uiText("研究方案", "Plan")}</small><strong>{plan.description || artifact.title}</strong></div>
      <div><small>{uiText("协议", "Protocol")}</small><strong>{plan.protocol || uiText("本地 Python 协议", "Local Python protocol")}</strong></div>
      <div><small>{uiText("入口", "Entry")}</small><strong>{plan.entrypoint}</strong></div>
      <div><small>{uiText("版本", "Version")}</small><strong>{plan.version ? `v${plan.version}` : uiText("未保存", "Unsaved")}</strong></div>
    </section>
    <ArtifactFacts artifact={artifact} uiText={uiText} />
    {source ? <section className="ai-inspector-code-surface" aria-label={uiText("策略代码", "Strategy code")}><header><strong>{uiText("Python 源码", "Python source")}</strong><span>{source.split("\n").length} {uiText("行", "lines")}</span></header><Suspense fallback={<pre className="ai-inspector-code">{source}</pre>}><SystematicPythonEditor value={source} readOnly ariaLabel={uiText("策略源代码预览", "Strategy source preview")} onChange={() => {}} /></Suspense></section> : <details className="ai-inspector-raw"><summary>{uiText("策略返回", "Strategy payload")}</summary><pre>{safeJson(artifact.data)}</pre></details>}
    {artifact.strategyId && onOpenStrategy ? <div className="ai-strategy-actions"><button type="button" className="ai-inspector-open-workspace" onClick={() => onOpenStrategy(artifact.strategyId!, artifact.runId, artifact.optimizationId)}>{uiText("在策略工作台继续编辑", "Continue in Strategy Lab")}</button><button type="button" className="ai-artifact-reference" onClick={() => onOpenStrategy(artifact.strategyId!, artifact.runId, artifact.optimizationId)}>{uiText("创建回测计划", "Create backtest plan")}</button></div> : null}
  </div>;
}

function intelligenceItems(response: IntelligenceResponse | null | undefined) {
  return response?.items ?? [];
}

function optionalResponse<T>(request: Promise<T>) {
  return request.catch(() => null);
}

function feedAsResponse(feed: NewsFeedPage | null): IntelligenceResponse | null {
  if (!feed) return null;
  return {
    source: "local-news-feed",
    sourceVersion: "feed",
    fetchedAt: Date.now(),
    dataAt: Date.now(),
    stale: false,
    items: feed.items,
    pagination: { hasMore: feed.page < feed.totalPages, nextAfter: String(feed.page + 1) },
    limitations: [],
    truncated: false
  };
}

function responseMeta(response: IntelligenceResponse | null | undefined, uiText: InspectorProps["uiText"]) {
  if (!response) return null;
  return <div className="ai-intel-meta"><span>{response.stale ? uiText("数据可能已过期", "Possibly stale") : uiText("本地数据", "Local data")}</span><span>{uiText("更新时间", "As of")} {formatTime(response.dataAt ?? response.fetchedAt)}</span>{response.truncated ? <span>{uiText("结果已截断", "Truncated")}</span> : null}</div>;
}

function valueFrom(item: IntelligenceRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}

function NewsDetailDialog({ detail, uiText, onClose }: { detail: NewsDetail; uiText: InspectorProps["uiText"]; onClose: () => void }) {
  const item = detail.record;
  const title = text(valueFrom(item, "title", "headline", "name")) || uiText("情报详情", "Intelligence detail");
  const body = text(valueFrom(item, "content", "originalText", "body", "text", "summary"));
  const source = text(valueFrom(item, "platform", "source", "publisher"));
  return <div className="ai-intel-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ai-intel-modal" role="dialog" aria-modal="true" aria-label={title}>
      <header><div><small>{detail.kind === "events" ? uiText("事件详情", "Event detail") : uiText("新闻详情", "News detail")}</small><h2>{title}</h2></div><button type="button" onClick={onClose} aria-label={uiText("关闭详情", "Close detail")}><X size={15} /></button></header>
      {detail.loading ? <div className="ai-inspector-loading">{uiText("正在读取详情…", "Loading detail…")}</div> : detail.error ? <div className="ai-inspector-error">{detail.error}</div> : <>
        <div className="ai-intel-modal-meta">{source || uiText("本地情报库", "Local intelligence store")} · {formatTime(valueFrom(item, "publishTime", "publishedAt", "firstPublishedAt", "lastPublishedAt"))}</div>
        <p>{body || uiText("此条记录没有可展开的正文。", "This record has no expanded body.")}</p>
        {Array.isArray(item.articles) && item.articles.length > 0 ? <div className="ai-intel-related"><strong>{uiText("关联文章", "Related articles")}</strong>{item.articles.slice(0, 12).map((article, index) => <div key={`${index}:${safeJson(article)}`}>{text(record(article).title) || safeJson(article)}</div>)}</div> : null}
        {text(valueFrom(item, "url", "link")) ? <a href={text(valueFrom(item, "url", "link"))} target="_blank" rel="noreferrer">{uiText("打开原文", "Open source")}</a> : null}
      </>}
    </section>
  </div>;
}

function NewsView({ data, mode, setMode, onOpen, uiText }: { data: Record<string, IntelligenceResponse | null>; mode: NewsMode; setMode: (mode: NewsMode) => void; onOpen: (record: IntelligenceRecord, kind: NewsMode) => void; uiText: InspectorProps["uiText"] }) {
  const response = data[mode];
  const items = intelligenceItems(response);
  return <div className="ai-intel-view">
    <div className="ai-intel-view-head"><div><h2><Newspaper size={16} />{uiText("新闻与事件", "News & events")}</h2><p>{uiText("完整列表；点击任意条目查看详情。", "Full local list; select an item for its detail.")}</p></div><div className="ai-intel-subtabs" role="tablist"><button type="button" className={mode === "articles" ? "active" : ""} onClick={() => setMode("articles")}>{uiText("新闻", "Articles")}</button><button type="button" className={mode === "events" ? "active" : ""} onClick={() => setMode("events")}>{uiText("事件", "Events")}</button></div></div>
    {responseMeta(response, uiText)}
    <div className="ai-intel-list">{items.length > 0 ? items.map((item, index) => <button type="button" className="ai-intel-list-item" key={`${text(item.id) || text(item.title) || "item"}:${index}`} onClick={() => onOpen(item, mode)}><span className="ai-intel-list-marker">{String(index + 1).padStart(2, "0")}</span><span><strong>{text(valueFrom(item, "title", "headline", "name")) || uiText("未命名情报", "Untitled intelligence")}</strong><small>{text(valueFrom(item, "platform", "source", "publisher")) || uiText("本地采集", "Local collection")} · {formatTime(valueFrom(item, "publishTime", "publishedAt", "lastPublishedAt"))}</small><em>{text(valueFrom(item, "summary", "status"))}</em></span><ChevronRight size={14} /></button>) : <p className="ai-inspector-empty">{uiText("暂无情报记录。", "No intelligence records.")}</p>}</div>
  </div>;
}

function RatioBar({ label, value }: { label: string; value: number | null }) {
  const percentage = value === null ? 0 : Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
  return <div className="ai-intel-ratio"><span>{label}</span><i><b style={{ width: `${percentage}%` }} /></i><strong>{value === null ? "--" : `${percentage.toFixed(1)}%`}</strong></div>;
}

function displayValue(value: unknown) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(number) && String(value ?? "").trim() !== "" ? formatNumber(number) : text(value) || "--";
}

function EvidenceRows({ items, fields }: { items: IntelligenceRecord[]; fields: Array<[string, string]> }) {
  return <div className="ai-intel-evidence-rows">{items.slice(-12).reverse().map((item, index) => <div key={`${String(valueFrom(item, "ts", "time", "id"))}:${index}`}><time>{formatTime(valueFrom(item, "ts", "time", "bucketAt", "eventAt"))}</time>{fields.map(([field, label]) => <span key={field}><b>{label}</b>{displayValue(item[field])}</span>)}</div>)}</div>;
}

function CalendarTable({ items, uiText }: { items: IntelligenceRecord[]; uiText: InspectorProps["uiText"] }) {
  return <div className="ai-intel-calendar-scroll" tabIndex={0} aria-label={uiText("经济日历，可横向滚动查看全部字段", "Economic calendar. Scroll horizontally to view all columns.")}><div className="ai-intel-calendar-table"><div className="ai-intel-calendar-row head"><span>{uiText("时间", "Time")}</span><span>{uiText("事件", "Event")}</span><span>{uiText("地区", "Region")}</span><span>{uiText("重要性", "Impact")}</span><span>{uiText("前值", "Previous")}</span><span>{uiText("预期", "Forecast")}</span><span>{uiText("实际", "Actual")}</span></div>{items.slice(0, 200).map((item, index) => { const importance = text(valueFrom(item, "importance", "level", "impact")); const importanceLabel = importance === "3" ? uiText("高", "High") : importance === "2" ? uiText("中", "Medium") : uiText("低", "Low"); return <div className="ai-intel-calendar-row" key={`${String(valueFrom(item, "id", "eventId", "name"))}:${index}`}><time>{formatTime(valueFrom(item, "eventAt", "startTime", "time", "ts"))}</time><strong>{text(valueFrom(item, "title", "event", "name", "indicator")) || uiText("未命名事件", "Untitled event")}</strong><span>{text(valueFrom(item, "region", "country", "currency")) || "--"}</span><b className={`impact-${importance || "1"}`}>{importanceLabel}</b><span>{displayValue(valueFrom(item, "previous", "prev"))}</span><span>{displayValue(valueFrom(item, "forecast", "consensus", "expected"))}</span><span>{displayValue(valueFrom(item, "actual", "value"))}</span></div>; })}</div></div>;
}

function SentimentView({ responses, symbol, uiText }: { responses: Record<string, IntelligenceResponse | null>; symbol?: string; uiText: InspectorProps["uiText"] }) {
  const ranking = intelligenceItems(responses.sentimentRanking);
  const trend = intelligenceItems(responses.sentimentTrend);
  const calendar = intelligenceItems(responses.calendar);
  return <div className="ai-intel-view"><div className="ai-intel-view-head"><div><h2><Activity size={16} />{uiText("市场情绪", "Sentiment")}</h2><p>{symbol || uiText("全市场", "Whole market")} · 24h 排名、趋势与事件日历</p></div></div>{responseMeta(responses.sentimentRanking, uiText)}<section className="ai-intel-section"><h3>{uiText("情绪排名", "Sentiment ranking")}</h3><div className="ai-intel-ranking">{ranking.slice(0, 16).map((item, index) => <div className="ai-intel-ranking-row" key={`${String(valueFrom(item, "ccy", "symbol", "coin"))}:${index}`}><strong>{String(valueFrom(item, "ccy", "symbol", "coin"))}</strong><RatioBar label={uiText("看多", "Long")} value={numberValue(item, "bullishRatio", "longRatio", "positiveRatio")} /><small>{formatNumber(valueFrom(item, "mentionCount", "mentions"), 0)} {uiText("条提及", "mentions")}</small></div>)}</div></section>{trend.length > 0 ? <section className="ai-intel-section"><h3>{uiText("趋势采样", "Trend samples")}</h3><div className="ai-intel-trend-strip">{trend.slice(-24).map((item, index) => <RatioBar key={`${String(valueFrom(item, "ts", "bucketAt"))}:${index}`} label={formatTime(valueFrom(item, "ts", "bucketAt"))} value={numberValue(item, "bullishRatio", "longRatio", "positiveRatio")} />)}</div></section> : null}{calendar.length > 0 ? <section className="ai-intel-section ai-intel-calendar"><h3><CalendarDays size={12} />{uiText("经济日历", "Economic calendar")}<small>{calendar.length} {uiText("条事件", "events")}</small></h3><CalendarTable items={calendar} uiText={uiText}/></section> : null}</div>;
}

function liquidationSide(item: IntelligenceRecord) {
  const side = text(valueFrom(item, "side", "posSide")).toLowerCase();
  return side === "sell" || side === "buy" ? side : "unknown";
}

function LiquidationSummary({ items, uiText }: { items: IntelligenceRecord[]; uiText: InspectorProps["uiText"] }) {
  const sells = items.filter((item) => liquidationSide(item) === "sell");
  const buys = items.filter((item) => liquidationSide(item) === "buy");
  const known = sells.length + buys.length;
  const sellShare = known === 0 ? 0 : sells.length / known * 100;
  const buyShare = known === 0 ? 0 : buys.length / known * 100;
  const sellSize = sells.reduce((total, item) => total + (numberValue(item, "sz") ?? 0), 0);
  const buySize = buys.reduce((total, item) => total + (numberValue(item, "sz") ?? 0), 0);
  const sampleMax = Math.max(1, ...items.map((item) => numberValue(item, "sz") ?? 0));
  return <section className="ai-risk-visual ai-liquidation-visual" aria-label={uiText("清算概览", "Liquidation overview")}>
    <header><div><h3>{uiText("爆仓 / 清算概览", "Liquidation overview")}</h3><p>{uiText("交易所返回的已成交清算样本，不等于全市场累计爆仓额。", "Filled liquidation samples returned by the exchange, not total market liquidations.")}</p></div><strong>{items.length} {uiText("条样本", "samples")}</strong></header>
    <div className="ai-liquidation-split" role="img" aria-label={uiText(`卖出清算 ${sells.length} 条，买入清算 ${buys.length} 条`, `${sells.length} sell liquidations and ${buys.length} buy liquidations`)}>
      <div className="sell" style={{ flexBasis: `${sellShare}%` }}><span>{uiText("卖出清算", "Sell liquidations")}</span><b>{sells.length}</b><small>{uiText("通常是多头被强平", "Usually long liquidations")}</small></div>
      <div className="buy" style={{ flexBasis: `${buyShare}%` }}><span>{uiText("买入清算", "Buy liquidations")}</span><b>{buys.length}</b><small>{uiText("通常是空头被强平", "Usually short liquidations")}</small></div>
      {known < items.length ? <div className="unknown"><span>{uiText("未识别方向", "Unclassified")}</span><b>{items.length - known}</b></div> : null}
    </div>
    <div className="ai-liquidation-volume"><span>{uiText("样本合约数量", "Sample contract size")}</span><div><b className="sell">{uiText("卖出", "Sell")} {formatNumber(sellSize)}</b><b className="buy">{uiText("买入", "Buy")} {formatNumber(buySize)}</b></div><small>{uiText("数量单位以交易所合约定义为准。", "Units follow the exchange contract definition.")}</small></div>
    <div className="ai-liquidation-timeline" aria-label={uiText("清算强度时间线", "Liquidation intensity timeline")}>{items.slice(0, 32).map((item, index) => { const size = numberValue(item, "sz") ?? 0; const side = liquidationSide(item); return <div className={side} key={`${String(valueFrom(item, "id", "ts"))}:${index}`} title={`${formatTime(valueFrom(item, "ts"))} · ${displayValue(size)}`}><i style={{ height: `${Math.max(10, Math.min(100, size / sampleMax * 100))}%` }} /><span>{formatTime(valueFrom(item, "ts"))}</span></div>; })}</div>
    <div className="ai-risk-legend"><span className="sell">{uiText("卖出清算 = 通常多头强平", "Sell liquidation = usually long liquidation")}</span><span className="buy">{uiText("买入清算 = 通常空头强平", "Buy liquidation = usually short liquidation")}</span></div>
  </section>;
}

function SystemRiskSummary({ item, uiText }: { item: IntelligenceRecord; uiText: InspectorProps["uiText"] }) {
  const insurance = valueFrom(item, "insuranceBalance");
  const upper = numberValue(item, "upperLimit");
  const lower = numberValue(item, "lowerLimit");
  const rawAdl = text(valueFrom(item, "adlState")).toLowerCase();
  const adlWarning = rawAdl === "warning";
  const adlLabel = adlWarning
    ? uiText("收到 ADL 预警", "ADL warning received")
    : rawAdl === "unknown" || !rawAdl
      ? uiText("未收到可确认的 ADL 预警", "No confirmed ADL warning received")
      : rawAdl;
  const limitation = text(valueFrom(item, "limitation"));
  return <section className="ai-risk-visual ai-system-risk-visual" aria-label={uiText("交易所系统风险概览", "Exchange system-risk overview")}>
    <header><div><h3>{uiText("交易所风险缓冲", "Exchange risk buffer")}</h3><p>{uiText("观察交易所的风险缓冲、价格限制和自动减仓信号。", "Observe exchange risk buffers, price limits, and auto-deleveraging signals.")}</p></div><strong className={adlWarning ? "warning" : "neutral"}>{adlWarning ? uiText("预警", "Warning") : uiText("未确认预警", "No confirmed warning")}</strong></header>
    <div className="ai-system-risk-metrics"><div><small>{uiText("保险基金余额", "Insurance fund balance")}</small><strong>{displayValue(insurance)}</strong><span>{uiText("交易所风险缓冲，单位以返回数据为准", "Exchange risk buffer; unit follows returned data")}</span></div><div className={adlWarning ? "warning" : "neutral"}><small>{uiText("自动减仓 ADL", "Auto-deleveraging")}</small><strong>{adlLabel}</strong><span>{uiText("不是你的账户强平状态", "Not your account liquidation status")}</span></div></div>
    <div className="ai-price-limits"><div><strong>{uiText("交易所价格限制区间", "Exchange price-limit range")}</strong><small>{uiText("限制委托与交易价格，不是清算价或止损价。", "Limits order and trade prices; not liquidation or stop prices.")}</small></div>{upper !== null && lower !== null ? <><div className="ai-price-limits-track" role="img" aria-label={uiText("价格限制区间", "Price-limit range")}><i /></div><div className="ai-price-limits-values"><span><b>{uiText("下限", "Lower")}</b>{formatNumber(lower)}</span><span><b>{uiText("上限", "Upper")}</b>{formatNumber(upper)}</span></div></> : <p>{uiText("当前未返回完整价格限制区间。", "The exchange did not return a complete price-limit range.")}</p>}</div>
    <p className="ai-system-risk-note">{limitation || uiText("ADL 状态只有在收到交易所 ADL 预警事件后才会更新。", "ADL updates only when the exchange sends an ADL warning event.")}</p>
  </section>;
}

function DerivativesView({ responses, symbol, uiText }: { responses: Record<string, IntelligenceResponse | null>; symbol?: string; uiText: InspectorProps["uiText"] }) {
  const instId = symbol || "BTC-USDT-SWAP";
  const positioning = responses.positioning;
  const taker = responses.takerFlow;
  const crowding = responses.crowding;
  const funding = responses.fundingBasis;
  const liquidations = responses.liquidations;
  const systemRisk = responses.systemRisk;
  const anomalies = responses.anomalies;
  const latest = (key: string) => intelligenceItems(responses[key]).at(-1) ?? {};
  const position = latest("positioning");
  const flow = latest("takerFlow");
  const crowd = latest("crowding");
  const basis = latest("fundingBasis");
  return <div className="ai-intel-view"><div className="ai-intel-view-head"><div><h2><ChartNoAxesCombined size={16} />{uiText("衍生品", "Derivatives")}</h2><p>{instId} · {uiText("1 小时市场结构", "1h market structure")}</p></div></div>{responseMeta(positioning, uiText)}<div className="ai-intel-metric-grid"><div><small>{uiText("持仓量", "Open interest")}</small><strong>{formatNumber(valueFrom(position, "oiUsd", "oi"))}</strong></div><div><small>{uiText("主动买入", "Buy volume")}</small><strong>{formatNumber(valueFrom(flow, "buyVol"))}</strong></div><div><small>{uiText("多空账户", "Account ratio")}</small><strong>{formatNumber(valueFrom(crowd, "accountRatio"))}</strong></div><div><small>{uiText("资金费率", "Funding")}</small><strong>{formatNumber(valueFrom(basis, "fundingRate", "nextFundingRate"), 5)}</strong></div></div><section className="ai-intel-chart-stack"><div><h3>{uiText("持仓变化", "Positioning")}</h3>{positioning ? <IntelligenceEvidenceChart kind="positioning" items={intelligenceItems(positioning)} height={138} ariaLabel={uiText("持仓变化图", "Open interest chart")} /> : null}</div><div><h3>{uiText("主动成交", "Taker flow")}</h3>{taker ? <IntelligenceEvidenceChart kind="takerFlow" items={intelligenceItems(taker)} height={138} ariaLabel={uiText("主动成交图", "Taker flow chart")} /> : null}</div></section>{liquidations && intelligenceItems(liquidations).length > 0 ? <LiquidationSummary items={intelligenceItems(liquidations)} uiText={uiText} /> : <section className="ai-risk-empty"><h3>{uiText("爆仓 / 清算概览", "Liquidation overview")}</h3><p>{uiText("当前没有读取到清算样本。", "No liquidation samples were returned.")}</p></section>}{systemRisk && intelligenceItems(systemRisk).length > 0 ? <><SystemRiskSummary item={intelligenceItems(systemRisk).at(-1) ?? {}} uiText={uiText} /><details className="ai-risk-history"><summary>{uiText("查看历史风险采样", "View risk history")}</summary><EvidenceRows items={intelligenceItems(systemRisk)} fields={[["insuranceBalance", uiText("保险基金", "Insurance fund")], ["adlState", uiText("ADL 状态", "ADL state")], ["upperLimit", uiText("价格上限", "Upper limit")], ["lowerLimit", uiText("价格下限", "Lower limit")]]}/></details></> : null}{anomalies && intelligenceItems(anomalies).length > 0 ? <section className="ai-intel-section"><h3>{uiText("异常", "Anomalies")}</h3><EvidenceRows items={intelligenceItems(anomalies)} fields={[["severity", uiText("级别", "Severity")], ["robustZScore", uiText("Z 分数", "Z-score")], ["kind", uiText("类型", "Kind")]]}/></section> : null}<details className="ai-inspector-raw"><summary>{uiText("衍生品原始证据", "Raw derivatives evidence")}</summary><pre>{safeJson({ positioning, taker, crowding, funding, liquidations, systemRisk, anomalies })}</pre></details></div>;
}

function SmartMoneyView({ responses, symbol, uiText }: { responses: Record<string, IntelligenceResponse | null>; symbol?: string; uiText: InspectorProps["uiText"] }) {
  const signals = intelligenceItems(responses.smartSignals);
  const traders = intelligenceItems(responses.smartTraders);
  return <div className="ai-intel-view"><div className="ai-intel-view-head"><div><h2><Users size={16} />{uiText("Smart Money", "Smart Money")}</h2><p>{symbol || uiText("全市场", "Whole market")} · 信号、趋势与交易者排名</p></div></div>{responseMeta(responses.smartSignals, uiText)}<section className="ai-intel-section"><h3>{uiText("资金信号", "Capital signals")}</h3><div className="ai-intel-list compact">{signals.slice(0, 20).map((item, index) => <div className="ai-intel-list-item static" key={`${String(valueFrom(item, "instCcy", "ccy", "symbol"))}:${index}`}><span className="ai-intel-list-marker">{String(index + 1).padStart(2, "0")}</span><span><strong>{String(valueFrom(item, "instCcy", "ccy", "symbol"))}</strong><small>{uiText("多头", "Long")} {formatNumber(valueFrom(item, "weightedLongRatio", "longRatio"), 3)} · {uiText("空头", "Short")} {formatNumber(valueFrom(item, "weightedShortRatio", "shortRatio"), 3)}</small><em>{formatNumber(valueFrom(item, "netNotionalUsdt", "netNotional", "capitalFlow"))}</em></span></div>)}</div></section><section className="ai-intel-section"><h3>{uiText("交易者排名", "Trader ranking")}</h3><div className="ai-intel-trader-grid">{traders.slice(0, 12).map((item, index) => <div key={`${String(valueFrom(item, "authorId", "id"))}:${index}`}><strong>{String(valueFrom(item, "nickname", "nickName", "name"))}</strong><span>{uiText("收益", "Return")} {formatNumber(valueFrom(item, "pnl", "profit"))}</span><small>{uiText("胜率", "Win rate")} {formatNumber(valueFrom(item, "winRate", "winRatio"), 2)}</small></div>)}</div></section></div>;
}

function HistoryView({ responses, uiText }: { responses: Record<string, IntelligenceResponse | null>; uiText: InspectorProps["uiText"] }) {
  const entries = [...intelligenceItems(responses.historyNews), ...intelligenceItems(responses.historyEvents)].sort((a, b) => Number(valueFrom(b, "publishTime", "publishedAt", "lastPublishedAt")) - Number(valueFrom(a, "publishTime", "publishedAt", "lastPublishedAt")));
  const sentiment = intelligenceItems(responses.historySentiment);
  return <div className="ai-intel-view"><div className="ai-intel-view-head"><div><h2><History size={16} />{uiText("历史记录", "History")}</h2><p>{uiText("本地情报库中的新闻、事件与情绪样本。", "Historical local news, events, and sentiment samples.")}</p></div></div>{responseMeta(responses.historyNews, uiText)}<div className="ai-intel-history-list">{entries.slice(0, 100).map((item, index) => <div key={`${String(valueFrom(item, "id", "title"))}:${index}`}><time>{formatTime(valueFrom(item, "publishTime", "publishedAt", "lastPublishedAt"))}</time><strong>{text(valueFrom(item, "title", "headline", "name")) || uiText("未命名记录", "Untitled record")}</strong><small>{text(valueFrom(item, "source", "platform")) || uiText("本地采集", "Local collection")}</small></div>)}</div>{sentiment.length > 0 ? <section className="ai-intel-section"><h3>{uiText("历史情绪样本", "Historical sentiment")}</h3><EvidenceRows items={sentiment} fields={[["bullishRatio", uiText("看多", "Long")], ["bearishRatio", uiText("看空", "Short")], ["mentionCount", uiText("提及", "Mentions")]]}/></section> : null}</div>;
}

function RadarPanel({ marketAssets, marketTickers, cacheDir, onResearchPrompt, uiText }: { marketAssets?: MarketAssetsSummary | null; marketTickers?: Ticker[]; cacheDir?: string; onResearchPrompt?: (prompt: string) => void; uiText: InspectorProps["uiText"] }) {
  const [tab, setTab] = useState<RadarPanelTab>("overview");
  const [researchScores, setResearchScores] = useState<MarketRadarResearchScore[]>([]);
  const rows = useMemo(() => buildMarketRadarRows(marketAssets?.instruments ?? [], marketTickers ?? [], researchScores), [marketAssets?.instruments, marketTickers, researchScores]);
  useEffect(() => { let active = true; void loadMarketRadarResearchScores().then((scores) => { if (active) setResearchScores(scores); }); return () => { active = false; }; }, []);
  const ranked = useMemo(() => {
    const next = [...rows];
    if (tab === "strength") next.sort((a, b) => (b.research?.relativeStrength30dPct ?? b.change24hPct) - (a.research?.relativeStrength30dPct ?? a.change24hPct));
    if (tab === "movers") next.sort((a, b) => b.amplitude24hPct - a.amplitude24hPct);
    if (tab === "active") next.sort((a, b) => b.turnover24h - a.turnover24h);
    if (tab === "stable") next.sort((a, b) => (a.research?.volatility20dPct ?? a.amplitude24hPct) - (b.research?.volatility20dPct ?? b.amplitude24hPct));
    return next.slice(0, 8);
  }, [rows, tab]);
  const tabs: Array<[RadarPanelTab, string, string]> = [["overview", "综合", "Overview"], ["strength", "强势", "Strength"], ["movers", "异动", "Movers"], ["active", "活跃", "Activity"], ["stable", "稳健", "Stable"]];
  return <div className="ai-radar-panel">
    <div className="ai-radar-panel-head"><div><div className="ai-inspector-kicker">{uiText("市场雷达", "MARKET RADAR")}</div><h2>{uiText("市场雷达", "Market Radar")}</h2><p>{uiText("全市场发现与研究优先级", "Cross-market discovery and research priority")}</p></div><Gauge size={18} /></div>
    <nav className="ai-radar-tabs" role="tablist" aria-label={uiText("雷达视图", "Radar views")}>{tabs.map(([id, zh, en]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{uiText(zh, en)}</button>)}</nav>
    <div className="ai-radar-meta"><span>{rows.length ? uiText(`${rows.length} 个可用市场`, `${rows.length} markets available`) : uiText("等待市场快照", "Waiting for market snapshot")}</span><span>{researchScores.length ? uiText("含本地研究分", "Local research") : uiText("快照评分", "Snapshot scores")}</span></div>
    <div className="ai-radar-list">{ranked.length ? ranked.map((row, index) => { const instId = row.instrument.instId; const prompt = uiText(`围绕 ${instId} 做一次市场研究：结合最新价格、24h 涨跌、成交额、本地研究评分和当前雷达「${tabs.find(([id]) => id === tab)?.[0] ?? "综合"}」视图，给出证据、风险和下一步。`, `Research ${instId}: combine latest price, 24h change, turnover, local research score, and the current radar view; return evidence, risks, and next steps.`); return <button type="button" className="ai-radar-row" style={{ transitionDelay: `${Math.min(index * 14, 90)}ms` }} key={instId} onClick={() => onResearchPrompt?.(prompt)} title={uiText(`围绕 ${instId} 生成研究指令`, `Draft a research prompt for ${instId}`)} aria-label={uiText(`围绕 ${instId} 生成研究指令`, `Draft a research prompt for ${instId}`)}><b>{index + 1}</b><SymbolIcon base={row.instrument.baseCcy} iconPath={row.instrument.iconPath} cached={row.instrument.iconCached} cacheDir={cacheDir} /><span><strong>{row.instrument.baseCcy}</strong><small>{row.instrument.localizedSecurityName || row.instrument.securityName || instId}</small></span><em className={row.change24hPct >= 0 ? "positive" : "negative"}>{row.change24hPct >= 0 ? "+" : ""}{row.change24hPct.toFixed(2)}%</em><i><span style={{ width: `${Math.max(4, Math.min(100, row.compositeScore))}%` }} /></i></button>; }) : <p className="ai-inspector-empty">{uiText("暂无市场快照。", "No market snapshot is available.")}</p>}</div>
  </div>;
}

function IntelligenceSection({ symbol, accountId, onOpenIntelligence, uiText }: { symbol?: string; accountId?: string; onOpenIntelligence?: () => void; uiText: InspectorProps["uiText"] }) {
  const [tab, setTab] = useState<IntelligenceTab>("news");
  const [newsMode, setNewsMode] = useState<NewsMode>("articles");
  const [responses, setResponses] = useState<Record<string, IntelligenceResponse | null>>({});
  const [summary, setSummary] = useState<IntelligenceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<NewsDetail | null>(null);
  const instrument = symbol || "BTC-USDT-SWAP";
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    const coin = instrument.split("-")[0];
    const load = async () => {
      if (tab === "news") {
        const feed = await optionalResponse(queryNewsFeed({
          mode: newsMode,
          coins: [coin],
          language: resolvedLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US",
          page: 1,
          pageSize: 50
        }));
        return { summary: null, data: { [newsMode]: feedAsResponse(feed) } };
      }
      if (tab === "sentiment") {
        const [ranking, trend] = await Promise.all([
          optionalResponse(querySentiment({ accountId, period: "24h", sortBy: "hot", limit: 20, localOnly: true })),
          optionalResponse(querySentiment({ accountId, coins: [coin], period: "1h", trendPoints: 18, limit: 18, localOnly: true }))
        ]);
        void optionalResponse(queryCalendar({ accountId, limit: 80, localOnly: true })).then((calendar) => {
          if (!disposed) setResponses((current) => ({ ...current, calendar }));
        });
        return { data: { sentimentRanking: ranking, sentimentTrend: trend } };
      }
      if (tab === "derivatives") {
        const [positioning, takerFlow, crowding, fundingBasis, liquidations, systemRisk, anomalies] = await Promise.all([
          optionalResponse(queryDerivatives("positioning", { instId: instrument, period: "1H", limit: 48 })),
          optionalResponse(queryDerivatives("takerFlow", { instId: instrument, period: "1H", limit: 48 })),
          optionalResponse(queryDerivatives("crowding", { instId: instrument, period: "1H", limit: 48 })),
          optionalResponse(queryDerivatives("fundingBasis", { instId: instrument, period: "1H", limit: 48 })),
          optionalResponse(queryDerivatives("liquidations", { instId: instrument, period: "1H", limit: 48 })),
          optionalResponse(queryDerivatives("systemRisk", { instId: instrument, period: "1H", limit: 24 })),
          optionalResponse(queryAnomalies({ instId: instrument, period: "1H", limit: 24 }))
        ]);
        return { data: { positioning, takerFlow, crowding, fundingBasis, liquidations, systemRisk, anomalies } };
      }
      if (tab === "smart") {
        const [smartSignals, smartTrend, smartTraders] = await Promise.all([
          optionalResponse(querySmartMoney({ accountId, operation: "signalOverviewByFilter", topInstruments: 20, sortType: "pnl", period: "30", limit: 20 })),
          optionalResponse(querySmartMoney({ accountId, operation: "signalTrendByFilter", instId: instrument, granularity: "1h", period: "30", limit: 48 })),
          optionalResponse(querySmartMoney({ accountId, operation: "traders", sortType: "pnl", period: "90", limit: 20 }))
        ]);
        return { data: { smartSignals, smartTrend, smartTraders } };
      }
      const [historyNews, historyEvents, historySentiment] = await Promise.all([
        optionalResponse(queryNews({ accountId, detailLevel: "summary", sortBy: "latest", limit: 100, localOnly: true })),
        optionalResponse(queryNewsEvents({ limit: 100 })),
        optionalResponse(querySentiment({ accountId, period: "24h", limit: 100, localOnly: true }))
      ]);
      return { data: { historyNews, historyEvents, historySentiment } };
    };
    load().then((result) => {
      if (disposed) return;
      setSummary(result.summary ?? null);
      setResponses((current) => ({ ...current, ...(result.data as unknown as Record<string, IntelligenceResponse | null>) }));
    }).catch((reason) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : uiText("市场情报暂不可用", "Market intelligence unavailable"));
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [accountId, instrument, newsMode, tab, uiText]);

  const openDetail = async (item: IntelligenceRecord, kind: NewsMode) => {
    const id = text(valueFrom(item, "id", "newsId", "eventId"));
    setDetail({ kind, record: item, loading: Boolean(id) });
    if (!id) return;
    try {
      const response = kind === "articles" ? await readNewsDetail(accountId, id, true) : await readNewsEvent(id);
      setDetail((current) => current ? { ...current, record: response?.items?.[0] ?? item, loading: false } : current);
    } catch (reason) {
      setDetail((current) => current ? { ...current, loading: false, error: reason instanceof Error ? reason.message : uiText("详情读取失败", "Unable to load detail") } : current);
    }
  };

  const sectionTabs: Array<[IntelligenceTab, ReactNode, string]> = [
    ["news", <Newspaper size={15} />, uiText("新闻", "News")],
    ["sentiment", <Activity size={15} />, uiText("情绪", "Sentiment")],
    ["derivatives", <ChartNoAxesCombined size={15} />, uiText("衍生品", "Derivatives")],
    ["smart", <Users size={15} />, uiText("Smart Money", "Smart Money")],
    ["history", <History size={15} />, uiText("历史", "History")]
  ];
  const responseKeyCount = Object.keys(responses).length;
  return <div className="ai-intelligence-workspace">
    <nav className="ai-intelligence-nav" aria-label={uiText("市场情报板块", "Market intelligence sections")}>{sectionTabs.map(([id, icon, label]) => <button key={id} type="button" className={tab === id ? "active" : ""} onClick={() => setTab(id)} title={label} aria-label={label} aria-current={tab === id ? "page" : undefined}>{icon}<span>{label}</span></button>)}</nav>
    <div className="ai-intelligence-main">
      <header className="ai-intelligence-head"><div><div className="ai-inspector-kicker">{uiText("市场情报", "MARKET INTELLIGENCE")}</div><h2>{instrument}</h2><p>{summary ? `${summary.counts.news ?? 0} ${uiText("条新闻", "news")} · ${responseKeyCount} ${uiText("个数据视图已加载", "views loaded")}` : uiText("新闻、情绪、衍生品与 Smart Money", "News, sentiment, derivatives, and Smart Money")}</p></div><button type="button" className="ai-intelligence-expand" onClick={onOpenIntelligence} disabled={!onOpenIntelligence} title={uiText("打开完整市场情报", "Open full Market Intelligence")} aria-label={uiText("打开完整市场情报", "Open full Market Intelligence")}><Maximize2 size={17} /></button></header>
      {loading ? <div className="ai-inspector-loading">{uiText("正在读取本地情报…", "Reading local intelligence…")}</div> : error ? <div className="ai-inspector-error" role="alert">{error}</div> : tab === "news" ? <NewsView data={responses} mode={newsMode} setMode={setNewsMode} onOpen={openDetail} uiText={uiText} /> : tab === "sentiment" ? <SentimentView responses={responses} symbol={instrument} uiText={uiText} /> : tab === "derivatives" ? <DerivativesView responses={responses} symbol={instrument} uiText={uiText} /> : tab === "smart" ? <SmartMoneyView responses={responses} symbol={instrument} uiText={uiText} /> : <HistoryView responses={responses} uiText={uiText} />}
    </div>
    {detail ? <NewsDetailDialog detail={detail} uiText={uiText} onClose={() => setDetail(null)} /> : null}
  </div>;
}

function ArtifactReference({ artifact, onOpenMessage, uiText }: { artifact: AiResearchArtifact; onOpenMessage?: (messageId: string) => void; uiText: InspectorProps["uiText"] }) {
  if (!artifact.sourceMessageId || !onOpenMessage) return null;
  return <button type="button" className="ai-artifact-reference" onClick={() => onOpenMessage(artifact.sourceMessageId!)} title={uiText("跳回引用它的回答", "Jump to the answer that referenced it")} aria-label={uiText("跳回引用它的回答", "Jump to the answer that referenced it")}>{uiText("查看引用它的回答", "View referencing answer")}</button>;
}

function currentResearchCard({ selectedSymbol, accountLabel, state, uiText }: { selectedSymbol?: string; accountLabel?: string; state: InspectorSessionState; uiText: InspectorProps["uiText"] }) {
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
  const strategyCount = state.tabs.filter((tab) => tab.kind === "strategy").length;
  const evidenceCount = Math.max(0, state.tabs.length - 1);
  /* 空态降噪：仅有基线市场页签（无真实证据/产物）时不渲染"当前研究"卡，避免"证据 0 / 产物 0"空转 */
  if (state.tabs.length <= 1) return null;
  return <section className="ai-current-research" aria-label={uiText("当前研究上下文", "Current research context")}>
    <div className="ai-inspector-kicker">{uiText("当前研究", "CURRENT RESEARCH")}</div>
    <div className="ai-current-research-card">
      <div><small>{uiText("研究对象", "Subject")}</small><strong>{selectedSymbol || activeTab?.title || uiText("未选择", "None")}</strong></div>
      <div><small>{uiText("绑定账户", "Bound account")}</small><strong>{accountLabel || uiText("未绑定", "Not bound")}</strong></div>
      <div><small>{uiText("证据", "Evidence")}</small><strong>{evidenceCount}</strong></div>
      <div><small>{uiText("产物", "Artifacts")}</small><strong>{strategyCount}</strong></div>
    </div>
  </section>;
}

function defaultMarketTab(symbol: string | undefined, accountLabel: string | undefined, uiText: InspectorProps["uiText"]): InspectorTab {
  return { id: "market-overview", kind: "market", title: symbol || uiText("市场概览", "Market overview"), summary: accountLabel ? uiText(`当前绑定账户：${accountLabel}。选择一条市场工具结果以固定可引用证据。`, `Bound account: ${accountLabel}. Select a market tool result to pin attributable evidence.`) : uiText("选择一条市场工具结果以固定可引用证据。", "Select a market tool result to pin attributable evidence."), data: { symbol: symbol || "", account: accountLabel || "" } };
}

function researchGroups(state: InspectorSessionState) {
  const evidence = state.tabs.filter((tab) => ["market", "intelligence", "account", "trade", "skill"].includes(tab.kind));
  const artifacts = state.tabs.filter((tab) => ["strategy", "research"].includes(tab.kind));
  return { evidence, artifacts };
}

function ResearchTabRow({ tab, active, closable, selectedSymbol, onClose, onSelect, uiText }: { tab: InspectorTab; active: boolean; closable: boolean; selectedSymbol?: string; onClose: (id: string) => void; onSelect: (id: string) => void; uiText: InspectorProps["uiText"] }) {
  const displayTitle = artifactTitle(tab, selectedSymbol, uiText);
  return <div className={active ? "active" : ""}><button type="button" role="tab" aria-selected={active} onClick={() => onSelect(tab.id)} title={displayTitle}>{artifactIcon(tab.kind)}<span>{displayTitle}</span></button>{closable ? <button type="button" className="ai-inspector-tab-close" aria-label={uiText("关闭标签", "Close tab")} onClick={() => onClose(tab.id)}><X size={12} /></button> : null}</div>;
}

function ResearchTabGroup({ title, tabs, activeTabId, selectedSymbol, onClose, onSelect, uiText }: { title: string; tabs: InspectorTab[]; activeTabId: string; selectedSymbol?: string; onClose: (id: string) => void; onSelect: (id: string) => void; uiText: InspectorProps["uiText"] }) {
  if (tabs.length === 0) return null;
  return <section className="ai-inspector-tab-group" aria-label={title}><header><span>{title}</span><small>{tabs.length}</small></header><div role="presentation">{tabs.map((tab) => <ResearchTabRow key={tab.id} tab={tab} active={tab.id === activeTabId} closable={Boolean(tab.closable)} selectedSymbol={selectedSymbol} onClose={onClose} onSelect={onSelect} uiText={uiText} />)}</div></section>;
}

export function AiResearchInspector({ sessionId, artifact, selectedSymbol, accountId, accountLabel, skillDefinitions = [], open, section, onSectionChange, onClose, onOpenStrategy, onOpenIntelligence, onOpenTrading, onResearchPrompt, onOpenMessage, marketAssets, marketTickers, cacheDir, uiText }: InspectorProps) {
  const defaultTab = useMemo(() => defaultMarketTab(selectedSymbol, accountLabel, uiText), [accountLabel, selectedSymbol, uiText]);
  const [sessionStates, setSessionStates] = useState<Record<string, InspectorSessionState>>({});
  const state = sessionStates[sessionId] ?? { tabs: [defaultTab], activeTabId: defaultTab.id, section: "artifacts" as const };
  useEffect(() => {
    setSessionStates((current) => {
      const existing = current[sessionId];
      if (!existing) return current;
      return { ...current, [sessionId]: { ...existing, tabs: existing.tabs.map((tab) => tab.id === "market-overview" ? defaultTab : tab) } };
    });
  }, [defaultTab, sessionId]);
  useEffect(() => {
    if (!artifact) return;
    setSessionStates((current) => {
      const existing = current[sessionId] ?? { tabs: [defaultTab], activeTabId: defaultTab.id, section: "artifacts" as const };
      const nextTabs = [...existing.tabs.filter((tab) => tab.id !== artifact.id), { ...artifact, closable: artifact.id !== "market-overview" }].slice(-8);
      return { ...current, [sessionId]: { ...existing, tabs: nextTabs, activeTabId: artifact.id, section: "artifacts" } };
    });
    onSectionChange?.("artifacts");
  }, [artifact, defaultTab, onSectionChange, sessionId]);
  const updateState = (update: (current: InspectorSessionState) => InspectorSessionState) => setSessionStates((all) => ({ ...all, [sessionId]: update(all[sessionId] ?? { tabs: [defaultTab], activeTabId: defaultTab.id, section: "artifacts" }) }));

  useEffect(() => {
    if (!section) return;
    setSessionStates((all) => {
      const current = all[sessionId] ?? { tabs: [defaultTab], activeTabId: defaultTab.id, section: "artifacts" as const };
      return current.section === section ? all : { ...all, [sessionId]: { ...current, section } };
    });
  }, [defaultTab, section, sessionId]);
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? defaultTab;
  const groups = researchGroups(state);
  const closeTab = (id: string) => {
    if (id === "market-overview") return;
    updateState((current) => { const tabs = current.tabs.filter((tab) => tab.id !== id); return { ...current, tabs, activeTabId: current.activeTabId === id ? (tabs.at(-1)?.id ?? "market-overview") : current.activeTabId }; });
  };
  if (!open) return null;
  return <aside className="ai-research-inspector" aria-label={uiText("研究标签页", "Research tabs")}>
    <header className="ai-inspector-head"><strong>{uiText("研究标签页", "Research tabs")}</strong><button type="button" title={uiText("收起研究栏", "Collapse research panel")} aria-label={uiText("收起研究栏", "Collapse research panel")} onClick={onClose}><X size={15} /></button></header>
    <div className="ai-inspector-workspace">

      <div className={`ai-inspector-workspace-main${state.section === "intelligence" ? " intelligence-active" : state.section === "radar" ? " radar-active" : ""}`}>{state.section === "intelligence" ? <IntelligenceSection symbol={selectedSymbol} accountId={accountId} onOpenIntelligence={onOpenIntelligence} uiText={uiText} /> : state.section === "radar" ? <RadarPanel marketAssets={marketAssets} marketTickers={marketTickers} cacheDir={cacheDir} onResearchPrompt={onResearchPrompt} uiText={uiText} /> : <>
        <div className="ai-inspector-tabs" role="tablist" aria-label={uiText("已打开研究资料", "Open research artifacts")}><ResearchTabGroup title={uiText("证据链", "Evidence chain")} tabs={groups.evidence} activeTabId={activeTab.id} selectedSymbol={selectedSymbol} onClose={closeTab} onSelect={(id) => updateState((current) => ({ ...current, activeTabId: id }))} uiText={uiText} /><ResearchTabGroup title={uiText("产物 / 执行", "Artifacts / execution")} tabs={groups.artifacts} activeTabId={activeTab.id} selectedSymbol={selectedSymbol} onClose={closeTab} onSelect={(id) => updateState((current) => ({ ...current, activeTabId: id }))} uiText={uiText} /></div>
        <div className="ai-inspector-body" role="tabpanel">{currentResearchCard({ selectedSymbol, accountLabel, state, uiText })}{activeTab.kind === "market" ? <MarketArtifact artifact={activeTab} symbol={selectedSymbol} onOpenTrading={onOpenTrading} uiText={uiText} /> : activeTab.kind === "strategy" ? <StrategyArtifact artifact={activeTab} onOpenStrategy={onOpenStrategy} uiText={uiText} /> : activeTab.kind === "skill" ? <SkillArtifact artifact={activeTab} definitions={skillDefinitions} uiText={uiText} /> : <GenericArtifact artifact={activeTab} uiText={uiText} />}<ArtifactReference artifact={activeTab} onOpenMessage={onOpenMessage} uiText={uiText} /></div>
      </>}</div>
    </div>
  </aside>;
}

function GenericArtifact({ artifact, uiText }: { artifact: AiResearchArtifact; uiText: InspectorProps["uiText"] }) {
  const label = artifact.kind === "account" ? uiText("账户证据", "ACCOUNT EVIDENCE") : artifact.kind === "trade" ? uiText("交易预检", "TRADE PRECHECK") : artifact.kind === "intelligence" ? uiText("市场情报", "MARKET INTELLIGENCE") : uiText("研究资料", "RESEARCH ARTIFACT");
  return <div className="ai-inspector-content"><div className="ai-inspector-kicker">{label}</div><h2>{artifact.title}</h2><p>{artifact.summary}</p><ArtifactFacts artifact={artifact} uiText={uiText} /><details className="ai-inspector-raw"><summary>{uiText("原始载荷", "Raw payload")}</summary><pre>{safeJson(artifact.data)}</pre></details></div>;
}
