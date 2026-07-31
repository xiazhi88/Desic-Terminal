import {
  setChartWorkspaceLayout,
  type ChartWorkspaceDocument,
  type ChartWorkspaceLayout,
} from "./chartWorkspace";

export const CHART_LAYOUT_TEMPLATE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CHART_LAYOUT_TEMPLATE_STORAGE_KEY = "desic.chart-layout-templates.v1";
export const DEFAULT_CHART_LAYOUT_STATE_STORAGE_KEY = "desic.detached-chart-default-layout.v1";

export type ChartPaneLayoutSizing = Readonly<{
  columnRatio: number;
  rowRatio: number;
}>;

export type ChartLayoutTemplatePane = Readonly<{
  id: string;
  timeframe: string;
  indicatorIds: readonly string[];
}>;

/**
 * Intentionally excludes symbol and all account/trading state. A layout
 * template is reusable across markets without leaking a previous analysis
 * workspace into the next one.
 */
export type ChartLayoutTemplate = Readonly<{
  schemaVersion: typeof CHART_LAYOUT_TEMPLATE_SCHEMA_VERSION;
  id: string;
  name: string;
  layout: ChartWorkspaceLayout;
  layoutOrientation: "horizontal" | "vertical";
  panes: readonly ChartLayoutTemplatePane[];
  sizing: ChartPaneLayoutSizing;
  builtIn?: boolean;
  createdAt: number;
  updatedAt: number;
}>;

const MAX_TEMPLATES = 80;
const MAX_NAME_LENGTH = 64;
const MAX_INDICATORS_PER_PANE = 64;
const DEFAULT_SIZING: ChartPaneLayoutSizing = Object.freeze({ columnRatio: 0.5, rowRatio: 0.5 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLayout(value: unknown): value is ChartWorkspaceLayout {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function isOrientation(value: unknown): value is "horizontal" | "vertical" {
  return value === "horizontal" || value === "vertical";
}

function normalizeRatio(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : fallback;
}

function normalizeSizing(value: unknown): ChartPaneLayoutSizing {
  const source = isRecord(value) ? value : {};
  return {
    columnRatio: normalizeRatio(source.columnRatio, DEFAULT_SIZING.columnRatio),
    rowRatio: normalizeRatio(source.rowRatio, DEFAULT_SIZING.rowRatio),
  };
}

function normalizeName(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  return normalized || fallback;
}

function normalizeIdentifier(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().slice(0, 96).replace(/[^A-Za-z0-9._:-]/g, "-");
  return normalized || fallback;
}

function normalizeTimeframe(value: unknown, fallback = "30m") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().slice(0, 24);
  return normalized || fallback;
}

function normalizeIndicators(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    if (typeof candidate !== "string") return [];
    const identifier = normalizeIdentifier(candidate, "");
    if (!identifier || seen.has(identifier) || seen.size >= MAX_INDICATORS_PER_PANE) return [];
    seen.add(identifier);
    return [identifier];
  });
}

function timestamp(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function normalizeTemplate(value: unknown, fallbackNow = Date.now()): ChartLayoutTemplate | null {
  if (!isRecord(value) || value.schemaVersion !== CHART_LAYOUT_TEMPLATE_SCHEMA_VERSION || !isLayout(value.layout)) return null;
  const layout = value.layout;
  const rawPanes = Array.isArray(value.panes) ? value.panes : [];
  const panes = Array.from({ length: layout }, (_, index): ChartLayoutTemplatePane => {
    const candidate = isRecord(rawPanes[index]) ? rawPanes[index] : {};
    return {
      id: normalizeIdentifier(candidate.id, `pane-${index + 1}`),
      timeframe: normalizeTimeframe(candidate.timeframe),
      indicatorIds: normalizeIndicators(candidate.indicatorIds),
    };
  });
  const createdAt = timestamp(value.createdAt, fallbackNow);
  return {
    schemaVersion: CHART_LAYOUT_TEMPLATE_SCHEMA_VERSION,
    id: normalizeIdentifier(value.id, `layout-${createdAt}`),
    name: normalizeName(value.name, "未命名布局"),
    layout,
    layoutOrientation: isOrientation(value.layoutOrientation) ? value.layoutOrientation : "horizontal",
    panes,
    sizing: normalizeSizing(value.sizing),
    builtIn: Boolean(value.builtIn),
    createdAt,
    updatedAt: timestamp(value.updatedAt, createdAt),
  };
}

function readStorage(storageKey: string): unknown[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    const decoded: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(decoded) ? decoded : [];
  } catch {
    return [];
  }
}

function writeStorage(storageKey: string, templates: readonly ChartLayoutTemplate[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(templates));
  } catch {
    // Storage is a convenience cache. The caller can continue with in-memory templates.
  }
}

function loadStoredChartLayoutTemplates(storageKey: string): ChartLayoutTemplate[] {
  const seen = new Set<string>();
  return readStorage(storageKey)
    .flatMap((candidate) => {
      const template = normalizeTemplate(candidate);
      if (!template || seen.has(template.id)) return [];
      seen.add(template.id);
      return [template];
    })
    .filter((template) => !template.builtIn)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_TEMPLATES);
}

function builtinTemplate(
  id: string,
  name: string,
  layout: ChartWorkspaceLayout,
  layoutOrientation: "horizontal" | "vertical",
  panes: readonly Omit<ChartLayoutTemplatePane, "id">[],
  sizing: ChartPaneLayoutSizing = DEFAULT_SIZING,
): ChartLayoutTemplate {
  return {
    schemaVersion: CHART_LAYOUT_TEMPLATE_SCHEMA_VERSION,
    id,
    name,
    layout,
    layoutOrientation,
    panes: panes.map((pane, index) => ({ ...pane, id: `pane-${index + 1}` })),
    sizing,
    builtIn: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function builtinChartLayoutTemplates(): ChartLayoutTemplate[] {
  return [
    builtinTemplate("builtin-clean-price", "单图 · 纯净价格", 1, "horizontal", [
      { timeframe: "15m", indicatorIds: [] },
    ]),
    builtinTemplate("builtin-execution-dual", "执行 · 5m + 15m", 2, "horizontal", [
      { timeframe: "5m", indicatorIds: ["ma", "ema", "vwap", "volume-ma"] },
      { timeframe: "15m", indicatorIds: ["rsi", "macd"] },
    ], { columnRatio: 0.58, rowRatio: 0.5 }),
    builtinTemplate("builtin-trend-dual", "趋势 · 15m / 1H", 2, "vertical", [
      { timeframe: "15m", indicatorIds: ["supertrend", "volume-ma"] },
      { timeframe: "1H", indicatorIds: ["ichimoku", "adx", "rsi"] },
    ], { columnRatio: 0.5, rowRatio: 0.56 }),
    builtinTemplate("builtin-multiframe-three", "多周期 · 15m / 1H / 4H", 3, "horizontal", [
      { timeframe: "15m", indicatorIds: ["ma", "ema", "volume-ma"] },
      { timeframe: "1H", indicatorIds: ["macd", "rsi"] },
      { timeframe: "4H", indicatorIds: ["supertrend", "atr"] },
    ], { columnRatio: 0.6, rowRatio: 0.5 }),
    builtinTemplate("builtin-market-overview", "总览 · 5m / 15m / 1H / 4H", 4, "horizontal", [
      { timeframe: "5m", indicatorIds: ["ma", "ema"] },
      { timeframe: "15m", indicatorIds: ["rsi", "macd"] },
      { timeframe: "1H", indicatorIds: ["supertrend", "adx"] },
      { timeframe: "4H", indicatorIds: ["ichimoku", "atr"] },
    ]),
  ];
}

export function loadChartLayoutTemplates(storageKey = DEFAULT_CHART_LAYOUT_TEMPLATE_STORAGE_KEY): ChartLayoutTemplate[] {
  return [...builtinChartLayoutTemplates(), ...loadStoredChartLayoutTemplates(storageKey)];
}

export function createChartLayoutTemplate(
  document: ChartWorkspaceDocument,
  name: string,
  sizing: ChartPaneLayoutSizing = DEFAULT_SIZING,
  now = Date.now(),
): ChartLayoutTemplate {
  const safeNow = timestamp(now, Date.now());
  return {
    schemaVersion: CHART_LAYOUT_TEMPLATE_SCHEMA_VERSION,
    id: `layout-${safeNow}-${Math.random().toString(36).slice(2, 8)}`,
    name: normalizeName(name, "未命名布局"),
    layout: document.layout,
    layoutOrientation: document.layoutOrientation,
    panes: document.panes.slice(0, document.layout).map((pane, index) => ({
      id: normalizeIdentifier(pane.id, `pane-${index + 1}`),
      timeframe: normalizeTimeframe(pane.timeframe),
      indicatorIds: normalizeIndicators(pane.indicatorIds),
    })),
    sizing: normalizeSizing(sizing),
    createdAt: safeNow,
    updatedAt: safeNow,
  };
}

export function saveChartLayoutTemplate(
  template: ChartLayoutTemplate,
  storageKey = DEFAULT_CHART_LAYOUT_TEMPLATE_STORAGE_KEY,
): ChartLayoutTemplate[] {
  const normalized = normalizeTemplate(template);
  if (!normalized || normalized.builtIn) return loadChartLayoutTemplates(storageKey);
  const next = [{ ...normalized, builtIn: false }, ...loadStoredChartLayoutTemplates(storageKey).filter((item) => item.id !== normalized.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_TEMPLATES);
  writeStorage(storageKey, next);
  return loadChartLayoutTemplates(storageKey);
}

export function deleteChartLayoutTemplate(id: string, storageKey = DEFAULT_CHART_LAYOUT_TEMPLATE_STORAGE_KEY): ChartLayoutTemplate[] {
  const next = loadStoredChartLayoutTemplates(storageKey).filter((template) => template.id !== id);
  writeStorage(storageKey, next);
  return loadChartLayoutTemplates(storageKey);
}

export function applyChartLayoutTemplate(
  document: ChartWorkspaceDocument,
  template: ChartLayoutTemplate,
): Readonly<{ document: ChartWorkspaceDocument; sizing: ChartPaneLayoutSizing }> {
  const normalized = normalizeTemplate(template);
  if (!normalized) return { document, sizing: DEFAULT_SIZING };
  const resized = setChartWorkspaceLayout(document, normalized.layout, normalized.layoutOrientation);
  return {
    document: {
      ...resized,
      panes: resized.panes.map((pane, index) => {
        const source = normalized.panes[index];
        return source ? {
          ...pane,
          timeframe: source.timeframe,
          indicatorIds: [...source.indicatorIds],
        } : pane;
      }),
    },
    sizing: normalized.sizing,
  };
}

export function defaultChartPaneLayoutSizing(): ChartPaneLayoutSizing {
  return { ...DEFAULT_SIZING };
}

/** The reusable default for newly opened chart windows. It deliberately has no
 * symbol or account data, so opening ETH after BTC keeps the workspace shape
 * without dragging BTC into the new analysis. */
export function loadDefaultChartLayout(document: ChartWorkspaceDocument): Readonly<{ document: ChartWorkspaceDocument; sizing: ChartPaneLayoutSizing }> {
  if (typeof window === "undefined") return { document, sizing: defaultChartPaneLayoutSizing() };
  try {
    const raw = window.localStorage.getItem(DEFAULT_CHART_LAYOUT_STATE_STORAGE_KEY);
    const template = raw ? normalizeTemplate(JSON.parse(raw)) : null;
    return template ? applyChartLayoutTemplate(document, template) : { document, sizing: defaultChartPaneLayoutSizing() };
  } catch {
    return { document, sizing: defaultChartPaneLayoutSizing() };
  }
}

export function saveDefaultChartLayout(document: ChartWorkspaceDocument, sizing: ChartPaneLayoutSizing): void {
  if (typeof window === "undefined") return;
  try {
    const template = createChartLayoutTemplate(document, "最近使用", sizing);
    window.localStorage.setItem(DEFAULT_CHART_LAYOUT_STATE_STORAGE_KEY, JSON.stringify(template));
  } catch {
    // A failed convenience write must never interrupt the trading chart.
  }
}
