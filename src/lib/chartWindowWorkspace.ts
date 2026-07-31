/**
 * Versioned, renderer-agnostic state for detached chart windows.
 *
 * This file deliberately has no React, Tauri, localStorage, or chart-library
 * dependency. The host decides where to persist the serialized document;
 * parsing always treats persisted input as untrusted.
 */

export const CHART_WINDOW_WORKSPACE_VERSION = 1 as const;

export type ChartGridLayout = 1 | 2 | 4;

export type ChartWindowGeometry = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}>;

export type ChartWindowPane = Readonly<{
  id: string;
  symbol: string;
  timeframe: string;
  indicatorIds: readonly string[];
}>;

export type ChartWindowSyncSettings = Readonly<{
  /** Windows in the same non-null group may opt into synchronized interactions. */
  groupId: string | null;
  crosshair: boolean;
  timeRange: boolean;
  symbol: boolean;
  timeframe: boolean;
}>;

export type ChartWindowWorkspace = Readonly<{
  version: typeof CHART_WINDOW_WORKSPACE_VERSION;
  windowId: string;
  layout: ChartGridLayout;
  activePaneId: string;
  panes: readonly ChartWindowPane[];
  geometry: ChartWindowGeometry;
  sync: ChartWindowSyncSettings;
  updatedAt: number;
}>;

export type ChartWindowWorkspaceSeed = Readonly<{
  windowId: string;
  symbol: string;
  timeframe: string;
  layout?: ChartGridLayout;
  geometry?: Partial<ChartWindowGeometry>;
  sync?: Partial<ChartWindowSyncSettings>;
  updatedAt?: number;
}>;

export type ChartWindowWorkspaceParseResult = Readonly<{
  workspace: ChartWindowWorkspace;
  source: "current" | "legacy" | "fallback";
  error?: string;
}>;

const DEFAULT_SYMBOL = "BTC-USDT-SWAP";
const DEFAULT_TIMEFRAME = "30m";
const DEFAULT_WINDOW_WIDTH = 1200;
const DEFAULT_WINDOW_HEIGHT = 760;
const MIN_WINDOW_WIDTH = 640;
const MIN_WINDOW_HEIGHT = 480;
const MAX_WINDOW_DIMENSION = 16_384;
const MAX_WINDOW_COORDINATE = 32_768;
const MAX_IDENTIFIER_LENGTH = 96;
const MAX_INDICATORS_PER_PANE = 64;
const MAX_PANES = 4;

const DEFAULT_SYNC: ChartWindowSyncSettings = {
  groupId: null,
  crosshair: false,
  timeRange: false,
  symbol: false,
  timeframe: false,
};

const DEFAULT_GEOMETRY: ChartWindowGeometry = {
  x: 80,
  y: 80,
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
  maximized: false,
};

/** Maps a persisted grid choice to the native chart pane grid shape. */
export function getChartGridShape(layout: ChartGridLayout): Readonly<{ rows: number; columns: number }> {
  if (layout === 4) return { rows: 2, columns: 2 };
  if (layout === 2) return { rows: 1, columns: 2 };
  return { rows: 1, columns: 1 };
}

/** Creates a complete, valid document for a newly opened chart window. */
export function createChartWindowWorkspace(seed: ChartWindowWorkspaceSeed): ChartWindowWorkspace {
  const layout = normalizeLayout(seed.layout);
  const windowId = safeIdentifier(seed.windowId, "chart-window");
  const symbol = safeSymbol(seed.symbol);
  const timeframe = safeTimeframe(seed.timeframe);
  const panes = Array.from({ length: layout }, (_, index): ChartWindowPane => ({
    id: `pane-${index + 1}`,
    symbol,
    timeframe,
    indicatorIds: [],
  }));
  return normalizeWorkspace({
    version: CHART_WINDOW_WORKSPACE_VERSION,
    windowId,
    layout,
    activePaneId: panes[0].id,
    panes,
    geometry: { ...DEFAULT_GEOMETRY, ...seed.geometry },
    sync: { ...DEFAULT_SYNC, ...seed.sync },
    updatedAt: seed.updatedAt ?? Date.now(),
  });
}

/**
 * Parses either the current serialized workspace or the legacy detached-window
 * state (`symbol`, `timeframe`, and `panes`). Corrupt data never escapes this
 * boundary; callers receive a safe default instead.
 */
export function parseChartWindowWorkspace(
  value: unknown,
  fallback: ChartWindowWorkspaceSeed = {
    windowId: "chart-window",
    symbol: DEFAULT_SYMBOL,
    timeframe: DEFAULT_TIMEFRAME,
  },
): ChartWindowWorkspaceParseResult {
  const decoded = decodePersistedValue(value);
  if (!decoded.ok) {
    return { workspace: createChartWindowWorkspace(fallback), source: "fallback", error: decoded.error };
  }
  if (!isRecord(decoded.value)) {
    return { workspace: createChartWindowWorkspace(fallback), source: "fallback", error: "Chart workspace must be an object." };
  }

  if (decoded.value.version === CHART_WINDOW_WORKSPACE_VERSION) {
    return { workspace: normalizeWorkspace(decoded.value, fallback), source: "current" };
  }

  if (hasLegacyWindowShape(decoded.value)) {
    return { workspace: migrateLegacyWindowState(decoded.value, fallback), source: "legacy" };
  }

  return {
    workspace: createChartWindowWorkspace(fallback),
    source: "fallback",
    error: `Unsupported chart workspace version: ${String(decoded.value.version ?? "missing")}.`,
  };
}

/** Serializes only a normalized document, keeping persisted state bounded. */
export function serializeChartWindowWorkspace(workspace: ChartWindowWorkspace): string {
  return JSON.stringify(normalizeWorkspace(workspace));
}

export function setChartWindowLayout(workspace: ChartWindowWorkspace, layout: ChartGridLayout, now = Date.now()): ChartWindowWorkspace {
  const normalized = normalizeWorkspace(workspace);
  const nextLayout = normalizeLayout(layout);
  const primary = normalized.panes[0] ?? defaultPane(0, DEFAULT_SYMBOL, DEFAULT_TIMEFRAME);
  const panes = Array.from({ length: nextLayout }, (_, index) => normalized.panes[index] ?? defaultPane(index, primary.symbol, primary.timeframe));
  return normalizeWorkspace({
    ...normalized,
    layout: nextLayout,
    panes,
    activePaneId: panes.some((pane) => pane.id === normalized.activePaneId) ? normalized.activePaneId : panes[0].id,
    updatedAt: safeTimestamp(now),
  });
}

export function updateChartWindowPane(
  workspace: ChartWindowWorkspace,
  paneId: string,
  patch: Partial<Pick<ChartWindowPane, "symbol" | "timeframe" | "indicatorIds">>,
  now = Date.now(),
): ChartWindowWorkspace {
  const normalized = normalizeWorkspace(workspace);
  const targetId = safeIdentifier(paneId, normalized.panes[0].id);
  const panes = normalized.panes.map((pane) => pane.id === targetId
    ? normalizePane({ ...pane, ...patch }, pane.id, pane.symbol, pane.timeframe)
    : pane,
  );
  return normalizeWorkspace({ ...normalized, panes, updatedAt: safeTimestamp(now) });
}

export function updateChartWindowGeometry(
  workspace: ChartWindowWorkspace,
  geometry: Partial<ChartWindowGeometry>,
  now = Date.now(),
): ChartWindowWorkspace {
  return normalizeWorkspace({
    ...normalizeWorkspace(workspace),
    geometry: { ...workspace.geometry, ...geometry },
    updatedAt: safeTimestamp(now),
  });
}

export function updateChartWindowSync(
  workspace: ChartWindowWorkspace,
  sync: Partial<ChartWindowSyncSettings>,
  now = Date.now(),
): ChartWindowWorkspace {
  return normalizeWorkspace({
    ...normalizeWorkspace(workspace),
    sync: { ...workspace.sync, ...sync },
    updatedAt: safeTimestamp(now),
  });
}

function migrateLegacyWindowState(value: Record<string, unknown>, fallback: ChartWindowWorkspaceSeed): ChartWindowWorkspace {
  const symbol = safeSymbol(value.symbol, fallback.symbol);
  const timeframe = safeTimeframe(value.timeframe, fallback.timeframe);
  const legacyPanes = Array.isArray(value.panes) ? value.panes : [];
  const inferredLayout = normalizeLayoutForPaneCount(legacyPanes.length);
  const panes = Array.from({ length: inferredLayout }, (_, index) => {
    const candidate = legacyPanes[index];
    return normalizePane(candidate, `pane-${index + 1}`, symbol, timeframe);
  });
  return normalizeWorkspace({
    version: CHART_WINDOW_WORKSPACE_VERSION,
    windowId: safeIdentifier(value.id, fallback.windowId),
    layout: inferredLayout,
    activePaneId: panes[0].id,
    panes,
    geometry: DEFAULT_GEOMETRY,
    sync: DEFAULT_SYNC,
    updatedAt: safeTimestamp(value.updatedAt ?? fallback.updatedAt ?? Date.now()),
  });
}

function normalizeWorkspace(value: unknown, fallback?: ChartWindowWorkspaceSeed): ChartWindowWorkspace {
  const source = isRecord(value) ? value : {};
  const fallbackWorkspace = fallback ? createChartWindowWorkspace(fallback) : null;
  const layout = normalizeLayout(source.layout ?? fallbackWorkspace?.layout);
  const defaultSymbol = fallbackWorkspace?.panes[0]?.symbol ?? DEFAULT_SYMBOL;
  const defaultTimeframe = fallbackWorkspace?.panes[0]?.timeframe ?? DEFAULT_TIMEFRAME;
  const candidates = Array.isArray(source.panes) ? source.panes.slice(0, MAX_PANES) : [];
  const uniquePaneIds = new Set<string>();
  const panes = Array.from({ length: layout }, (_, index) => {
    const pane = normalizePane(candidates[index], `pane-${index + 1}`, defaultSymbol, defaultTimeframe);
    const id = uniqueIdentifier(pane.id, uniquePaneIds, `pane-${index + 1}`);
    uniquePaneIds.add(id);
    return { ...pane, id };
  });
  const requestedActiveId = safeIdentifier(source.activePaneId, panes[0].id);
  return {
    version: CHART_WINDOW_WORKSPACE_VERSION,
    windowId: safeIdentifier(source.windowId, fallbackWorkspace?.windowId ?? "chart-window"),
    layout,
    activePaneId: panes.some((pane) => pane.id === requestedActiveId) ? requestedActiveId : panes[0].id,
    panes,
    geometry: normalizeGeometry(source.geometry),
    sync: normalizeSync(source.sync),
    updatedAt: safeTimestamp(source.updatedAt),
  };
}

function normalizePane(value: unknown, fallbackId: string, fallbackSymbol: string, fallbackTimeframe: string): ChartWindowPane {
  const source = isRecord(value) ? value : {};
  return {
    id: safeIdentifier(source.id, fallbackId),
    symbol: safeSymbol(source.symbol, fallbackSymbol),
    timeframe: safeTimeframe(source.timeframe, fallbackTimeframe),
    indicatorIds: normalizeIndicatorIds(source.indicatorIds),
  };
}

function defaultPane(index: number, symbol: string, timeframe: string): ChartWindowPane {
  return { id: `pane-${index + 1}`, symbol, timeframe, indicatorIds: [] };
}

function normalizeGeometry(value: unknown): ChartWindowGeometry {
  const source = isRecord(value) ? value : {};
  return {
    x: clampFiniteNumber(source.x, DEFAULT_GEOMETRY.x, -MAX_WINDOW_COORDINATE, MAX_WINDOW_COORDINATE),
    y: clampFiniteNumber(source.y, DEFAULT_GEOMETRY.y, -MAX_WINDOW_COORDINATE, MAX_WINDOW_COORDINATE),
    width: clampFiniteNumber(source.width, DEFAULT_GEOMETRY.width, MIN_WINDOW_WIDTH, MAX_WINDOW_DIMENSION),
    height: clampFiniteNumber(source.height, DEFAULT_GEOMETRY.height, MIN_WINDOW_HEIGHT, MAX_WINDOW_DIMENSION),
    maximized: source.maximized === true,
  };
}

function normalizeSync(value: unknown): ChartWindowSyncSettings {
  const source = isRecord(value) ? value : {};
  return {
    groupId: source.groupId === null ? null : safeNullableIdentifier(source.groupId),
    crosshair: source.crosshair === true,
    timeRange: source.timeRange === true,
    symbol: source.symbol === true,
    timeframe: source.timeframe === true,
  };
}

function normalizeIndicatorIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    const id = safeNullableIdentifier(candidate);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_INDICATORS_PER_PANE) break;
  }
  return ids;
}

function normalizeLayout(value: unknown): ChartGridLayout {
  return value === 2 || value === 4 ? value : 1;
}

function normalizeLayoutForPaneCount(count: number): ChartGridLayout {
  if (count >= 4) return 4;
  if (count >= 2) return 2;
  return 1;
}

function safeSymbol(value: unknown, fallback = DEFAULT_SYMBOL): string {
  if (typeof value !== "string") return fallback;
  const symbol = value.trim().toUpperCase();
  return symbol.length > 0 && symbol.length <= MAX_IDENTIFIER_LENGTH ? symbol : fallback;
}

function safeTimeframe(value: unknown, fallback = DEFAULT_TIMEFRAME): string {
  if (typeof value !== "string") return fallback;
  const timeframe = value.trim();
  return timeframe.length > 0 && timeframe.length <= 24 ? timeframe : fallback;
}

function safeIdentifier(value: unknown, fallback: string): string {
  return safeNullableIdentifier(value) ?? fallback;
}

function safeNullableIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const identifier = value.trim();
  if (identifier.length === 0 || identifier.length > MAX_IDENTIFIER_LENGTH) return null;
  return /^[A-Za-z0-9._:-]+$/.test(identifier) ? identifier : null;
}

function uniqueIdentifier(candidate: string, used: ReadonlySet<string>, fallback: string): string {
  if (!used.has(candidate)) return candidate;
  let suffix = 2;
  while (used.has(`${fallback}-${suffix}`)) suffix += 1;
  return `${fallback}-${suffix}`;
}

function safeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
}

function clampFiniteNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function hasLegacyWindowShape(value: Record<string, unknown>): boolean {
  return typeof value.symbol === "string" || typeof value.timeframe === "string" || Array.isArray(value.panes);
}

function decodePersistedValue(value: unknown): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: string }> {
  if (typeof value !== "string") return { ok: true, value };
  if (value.length > 1_048_576) return { ok: false, error: "Chart workspace JSON exceeds 1 MiB." };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, error: "Chart workspace JSON is invalid." };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Dependency-free smoke assertions. Keep this exported so a future Node or
 * Vitest harness can call it without pulling React or a Tauri runtime.
 */
export function runChartWindowWorkspaceAssertions(): void {
  const initial = createChartWindowWorkspace({
    windowId: "chart-a",
    symbol: "btc-usdt-swap",
    timeframe: "5m",
    layout: 4,
    geometry: { width: 1500, height: 900, maximized: true },
    sync: { groupId: "analysis", crosshair: true, timeRange: true },
    updatedAt: 1,
  });
  assert(initial.panes.length === 4, "4-grid must create four panes.");
  assert(initial.panes.every((pane) => pane.symbol === "BTC-USDT-SWAP"), "pane symbols must be normalized.");
  assert(initial.geometry.maximized, "maximized state must be preserved.");
  assert(initial.sync.crosshair && initial.sync.timeRange, "sync flags must be preserved.");

  const restored = parseChartWindowWorkspace(serializeChartWindowWorkspace(initial));
  assert(restored.source === "current", "serialized current document must restore as current.");
  assert(restored.workspace.layout === 4 && restored.workspace.panes.length === 4, "grid layout must round-trip.");

  const legacy = parseChartWindowWorkspace({ id: "legacy", symbol: "eth-usdt-swap", timeframe: "1H", panes: [{ id: "one", symbol: "ETH-USDT-SWAP", timeframe: "1H" }] });
  assert(legacy.source === "legacy", "legacy detached window state must migrate.");
  assert(legacy.workspace.geometry.width === DEFAULT_WINDOW_WIDTH, "legacy state must receive default geometry.");

  const invalid = parseChartWindowWorkspace("{bad json");
  assert(invalid.source === "fallback", "malformed persisted JSON must fall back safely.");

  const resized = updateChartWindowGeometry(initial, { width: Number.POSITIVE_INFINITY, height: 5 });
  assert(resized.geometry.width === DEFAULT_WINDOW_WIDTH && resized.geometry.height === MIN_WINDOW_HEIGHT, "geometry must remain bounded.");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`chartWindowWorkspace assertion failed: ${message}`);
}
