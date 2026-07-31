import type { Candle, FundingRate, OrderBook, Ticker, Trade } from "../types";
import { evaluateChartIndicatorDsl, parseChartIndicatorDsl } from "../lib/chartIndicatorDsl";

export type ChartScriptVersion = {
  source: string;
  savedAt: number;
};

export type ChartScriptDefinition = {
  id: string;
  name: string;
  description: string;
  source: string;
  runtime?: "dsl" | "legacy-js";
  legacyReadOnly?: boolean;
  enabled: boolean;
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
  versions: ChartScriptVersion[];
};

export type ChartScriptContext = {
  symbol: string;
  candles: Candle[];
  ticker: Ticker | null;
  orderBook?: OrderBook | null;
  recentTrades?: Trade[];
  fundingRate?: FundingRate | null;
  orderBookPressure?: ChartScriptOrderBookPressure | null;
};

export type ChartScriptOrderBookPressure = {
  bidPercent: number;
  askPercent: number;
  activeBuyRatio: number;
  score: number;
  label: string;
  updatedAt: number;
};

export type ChartScriptLine = {
  id: string;
  name: string;
  points: { time: number; price: number }[];
  pane: "main" | "sub";
  kind: "line" | "histogram" | "area";
  paneId?: string;
  color?: string;
  width?: number;
};

export type ChartScriptHLine = {
  id: string;
  name: string;
  price: number;
  color?: string;
  width?: number;
  dashed?: boolean;
};

export type ChartScriptBand = {
  id: string;
  name: string;
  upper: { time: number; price: number }[];
  lower: { time: number; price: number }[];
  color?: string;
};

export type ChartScriptMarker = {
  id: string;
  time: number;
  price: number;
  text?: string;
  color?: string;
  shape?: "circle" | "arrowUp" | "arrowDown" | "square";
};

export type ChartScriptAlert = {
  id: string;
  source: "script";
  scriptId: string;
  name: string;
  direction: "above" | "below" | "cross";
  price: number;
  active: boolean;
  updatedAt: number;
};

export type ChartScriptOutput = {
  lines: ChartScriptLine[];
  hlines: ChartScriptHLine[];
  bands: ChartScriptBand[];
  markers: ChartScriptMarker[];
  labels: ChartScriptMarker[];
  alerts: ChartScriptAlert[];
};

export type ChartScriptRunState = {
  status: "idle" | "running" | "ready" | "error" | "timeout";
  output: ChartScriptOutput;
  error?: string;
  outputCount: number;
  runtimeMs?: number;
};

const STORAGE_KEY = "desictrade.chartScripts.v1";
const MAX_VERSIONS = 20;
const EMPTY_OUTPUT: ChartScriptOutput = { lines: [], hlines: [], bands: [], markers: [], labels: [], alerts: [] };

const DEFAULT_SCRIPT_SOURCE = JSON.stringify({
  schemaVersion: 1,
  name: "安全 MA 观察",
  parameters: [{ key: "length", label: "均线周期", type: "integer", defaultValue: 20, min: 2, max: 240 }],
  outputs: [{
    id: "ma",
    label: "MA",
    pane: "main",
    kind: "line",
    color: "#f5a524",
    expression: {
      type: "call",
      name: "sma",
      args: [{ type: "field", field: "close" }, { type: "parameter", key: "length" }]
    }
  }]
}, null, 2);

export function emptyChartScriptOutput(): ChartScriptOutput {
  return { lines: [], hlines: [], bands: [], markers: [], labels: [], alerts: [] };
}

export function createDefaultChartScript(): ChartScriptDefinition {
  const now = Date.now();
  return {
    id: `script-${now}-${Math.random().toString(16).slice(2)}`,
    name: "MA 观察",
    description: "使用安全 DSL 绘制可配置均线。",
    source: DEFAULT_SCRIPT_SOURCE,
    runtime: "dsl",
    enabled: false,
    hidden: false,
    createdAt: now,
    updatedAt: now,
    versions: [{ source: DEFAULT_SCRIPT_SOURCE, savedAt: now }]
  };
}

export function loadChartScripts(): ChartScriptDefinition[] {
  if (typeof window === "undefined") return [createDefaultChartScript()];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [createDefaultChartScript()];
    const parsed = JSON.parse(raw) as ChartScriptDefinition[];
    if (!Array.isArray(parsed)) return [createDefaultChartScript()];
    const scripts = parsed.filter(isValidChartScript).slice(0, 24).map(normalizeStoredChartScript);
    return scripts.length > 0 ? scripts : [createDefaultChartScript()];
  } catch {
    return [createDefaultChartScript()];
  }
}

export function saveChartScripts(scripts: ChartScriptDefinition[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts.slice(0, 24)));
}

export function withSavedChartScriptVersion(script: ChartScriptDefinition): ChartScriptDefinition {
  const now = Date.now();
  const latest = script.versions[script.versions.length - 1];
  const versions = latest?.source === script.source ? script.versions : [...script.versions, { source: script.source, savedAt: now }].slice(-MAX_VERSIONS);
  return { ...script, updatedAt: now, versions };
}

export async function runChartScript(script: ChartScriptDefinition, context: ChartScriptContext): Promise<ChartScriptRunState> {
  if (!script.enabled || script.hidden) {
    return { status: "idle", output: emptyChartScriptOutput(), outputCount: 0 };
  }
  if (script.runtime !== "dsl") {
    return {
      status: "error",
      output: emptyChartScriptOutput(),
      error: "旧版 JavaScript 图表脚本已切换为只读草稿。请转换为安全 DSL 后再运行。",
      outputCount: 0
    };
  }
  const startedAt = performance.now();
  const parsed = parseChartIndicatorDsl(script.source);
  if (!parsed.document) {
    return {
      status: "error",
      output: emptyChartScriptOutput(),
      error: parsed.diagnostics.filter((item) => item.severity === "error").map((item) => `${item.path}: ${item.message}`).join("\n") || "DSL 格式无效。",
      outputCount: 0,
      runtimeMs: Math.round(performance.now() - startedAt)
    };
  }
  const result = evaluateChartIndicatorDsl(parsed.document, context.candles);
  if (!result.ok) {
    return {
      status: "error",
      output: emptyChartScriptOutput(),
      error: result.diagnostics.filter((item) => item.severity === "error").map((item) => `${item.path}: ${item.message}`).join("\n") || "DSL 计算失败。",
      outputCount: 0,
      runtimeMs: Math.round(performance.now() - startedAt)
    };
  }
  const output: ChartScriptOutput = {
    ...emptyChartScriptOutput(),
    lines: result.series.map((series) => ({
      id: series.id,
      name: series.label,
      points: series.points.map((point) => ({ time: point.time, price: point.value })),
      pane: series.pane,
      kind: series.kind,
      color: series.color,
      width: series.kind === "histogram" ? 2 : 1
    }))
  };
  return {
    status: "ready",
    output,
    outputCount: countScriptOutput(output),
    runtimeMs: Math.round(performance.now() - startedAt)
  };
}

function isValidChartScript(value: unknown): value is ChartScriptDefinition {
  if (!value || typeof value !== "object") return false;
  const item = value as ChartScriptDefinition;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.source === "string";
}

function normalizeStoredChartScript(script: ChartScriptDefinition): ChartScriptDefinition {
  if (script.runtime === "dsl") return script;
  return {
    ...script,
    runtime: "legacy-js",
    legacyReadOnly: true,
    enabled: false,
    hidden: script.hidden ?? false
  };
}

function countScriptOutput(output: ChartScriptOutput) {
  return output.lines.reduce((sum, line) => sum + line.points.length, 0) + output.hlines.length + output.bands.reduce((sum, band) => sum + band.upper.length + band.lower.length, 0) + output.markers.length + output.labels.length + output.alerts.length;
}
