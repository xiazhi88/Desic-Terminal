/**
 * Serializable workspace state for professional chart windows. The runtime
 * chart adapter deliberately stays outside this module so workspace documents
 * can be stored, transferred between windows, and validated before use.
 */

export const CHART_WORKSPACE_SCHEMA_VERSION = 1 as const;

export type ChartWorkspaceLayout = 1 | 2 | 3 | 4;
export type ChartWorkspaceOrientation = "horizontal" | "vertical";
export type ChartWorkspacePaneId = string;
export type ChartWorkspaceSyncKey = "crosshair" | "timeRange" | "symbol" | "timeframe";

export type ChartWorkspacePane = Readonly<{
  id: ChartWorkspacePaneId;
  symbol: string;
  timeframe: string;
  indicatorIds: readonly string[];
  drawingTemplateId: string | null;
}>;

export type ChartWorkspaceSyncSettings = Readonly<Record<ChartWorkspaceSyncKey, boolean>>;

export type ChartWorkspaceSyncGroup = Readonly<{
  id: string;
  name: string;
  paneIds: readonly ChartWorkspacePaneId[];
  settings: ChartWorkspaceSyncSettings;
}>;

export type ChartWorkspaceDocument = Readonly<{
  schemaVersion: typeof CHART_WORKSPACE_SCHEMA_VERSION;
  id: string;
  name: string;
  layout: ChartWorkspaceLayout;
  layoutOrientation: ChartWorkspaceOrientation;
  panes: readonly ChartWorkspacePane[];
  syncGroups: readonly ChartWorkspaceSyncGroup[];
  activePaneId: ChartWorkspacePaneId;
}>;

export type CreateChartWorkspaceOptions = Readonly<{
  id?: string;
  name?: string;
  layout?: ChartWorkspaceLayout;
  layoutOrientation?: ChartWorkspaceOrientation;
  symbol?: string;
  timeframe?: string;
}>;

const DEFAULT_SYMBOL = "BTC-USDT-SWAP";
const DEFAULT_TIMEFRAME = "30m";
const DEFAULT_WORKSPACE_ID = "chart-workspace-default";
const MAX_IDENTIFIER_LENGTH = 96;
const MAX_LABEL_LENGTH = 64;
const MAX_INDICATORS_PER_PANE = 64;

const DEFAULT_SYNC_SETTINGS: ChartWorkspaceSyncSettings = Object.freeze({
  crosshair: false,
  timeRange: false,
  symbol: false,
  timeframe: false,
});

const isLayout = (value: unknown): value is ChartWorkspaceLayout => value === 1 || value === 2 || value === 3 || value === 4;
const isOrientation = (value: unknown): value is ChartWorkspaceOrientation => value === "horizontal" || value === "vertical";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizeText(value: unknown, fallback: string, maximumLength = MAX_IDENTIFIER_LENGTH) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().slice(0, maximumLength);
  return normalized || fallback;
}

function normalizeIdentifier(value: unknown, fallback: string) {
  const normalized = normalizeText(value, fallback).replace(/[^a-zA-Z0-9:_-]/g, "-");
  return normalized || fallback;
}

function paneId(index: number) {
  return `pane-${index + 1}`;
}

function defaultPane(index: number, symbol: string, timeframe: string): ChartWorkspacePane {
  return {
    id: paneId(index),
    symbol,
    timeframe,
    indicatorIds: [],
    drawingTemplateId: null,
  };
}

function normalizeIndicatorIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return unique(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeIdentifier(item, ""))
    .filter(Boolean))
    .slice(0, MAX_INDICATORS_PER_PANE);
}

function unique<T>(items: readonly T[]) {
  return [...new Set(items)];
}

function defaultSyncGroup(paneIds: readonly string[]): ChartWorkspaceSyncGroup {
  return {
    id: "sync-primary",
    name: "同步组 1",
    paneIds: [...paneIds],
    settings: { ...DEFAULT_SYNC_SETTINGS },
  };
}

function normalizePane(value: unknown, index: number, symbol: string, timeframe: string): ChartWorkspacePane {
  if (!isRecord(value)) return defaultPane(index, symbol, timeframe);
  return {
    id: normalizeIdentifier(value.id, paneId(index)),
    symbol: normalizeText(value.symbol, symbol),
    timeframe: normalizeText(value.timeframe, timeframe, 20),
    indicatorIds: normalizeIndicatorIds(value.indicatorIds),
    drawingTemplateId: typeof value.drawingTemplateId === "string"
      ? normalizeIdentifier(value.drawingTemplateId, "") || null
      : null,
  };
}

function normalizeSyncSettings(value: unknown): ChartWorkspaceSyncSettings {
  const source = isRecord(value) ? value : {};
  return {
    crosshair: Boolean(source.crosshair),
    timeRange: Boolean(source.timeRange),
    symbol: Boolean(source.symbol),
    timeframe: Boolean(source.timeframe),
  };
}

function normalizeSyncGroups(value: unknown, paneIds: readonly string[]) {
  if (!Array.isArray(value)) return [defaultSyncGroup(paneIds)];
  const knownPaneIds = new Set(paneIds);
  const usedIds = new Set<string>();
  const groups = value.flatMap((item, index): ChartWorkspaceSyncGroup[] => {
    if (!isRecord(item)) return [];
    const id = normalizeIdentifier(item.id, `sync-${index + 1}`);
    if (usedIds.has(id)) return [];
    const members = unique(Array.isArray(item.paneIds)
      ? item.paneIds.filter((pane): pane is string => typeof pane === "string" && knownPaneIds.has(pane))
      : []);
    if (members.length === 0) return [];
    usedIds.add(id);
    return [{
      id,
      name: normalizeText(item.name, `同步组 ${index + 1}`, MAX_LABEL_LENGTH),
      paneIds: members,
      settings: normalizeSyncSettings(item.settings),
    }];
  });
  return groups.length > 0 ? groups : [defaultSyncGroup(paneIds)];
}

function withNormalizedGroups(document: Omit<ChartWorkspaceDocument, "syncGroups"> & { syncGroups?: readonly ChartWorkspaceSyncGroup[] }) {
  return {
    ...document,
    syncGroups: normalizeSyncGroups(document.syncGroups, document.panes.map((pane) => pane.id)),
  } as ChartWorkspaceDocument;
}

/** Creates a deterministic 1/2/4 chart workspace document. */
export function createChartWorkspaceDocument(options: CreateChartWorkspaceOptions = {}): ChartWorkspaceDocument {
  const layout = options.layout ?? 1;
  const layoutOrientation = options.layoutOrientation ?? "horizontal";
  const symbol = normalizeText(options.symbol, DEFAULT_SYMBOL);
  const timeframe = normalizeText(options.timeframe, DEFAULT_TIMEFRAME, 20);
  const panes = Array.from({ length: layout }, (_, index) => defaultPane(index, symbol, timeframe));
  return {
    schemaVersion: CHART_WORKSPACE_SCHEMA_VERSION,
    id: normalizeIdentifier(options.id, DEFAULT_WORKSPACE_ID),
    name: normalizeText(options.name, "图表工作区", MAX_LABEL_LENGTH),
    layout,
    layoutOrientation,
    panes,
    syncGroups: [defaultSyncGroup(panes.map((pane) => pane.id))],
    activePaneId: panes[0].id,
  };
}

/** Parses storage/IPC data defensively. Invalid pieces fall back to a safe workspace. */
export function parseChartWorkspaceDocument(value: unknown, fallback: CreateChartWorkspaceOptions = {}): ChartWorkspaceDocument {
  const safe = createChartWorkspaceDocument(fallback);
  if (!isRecord(value) || value.schemaVersion !== CHART_WORKSPACE_SCHEMA_VERSION || !isLayout(value.layout)) return safe;

  const sourcePanes = Array.isArray(value.panes) ? value.panes : [];
  const rawPanes = sourcePanes.slice(0, value.layout);
  const panes = Array.from({ length: value.layout }, (_, index) => normalizePane(rawPanes[index], index, safe.panes[0].symbol, safe.panes[0].timeframe));
  const seenPaneIds = new Set<string>();
  const deduplicatedPanes = panes.map((pane, index) => {
    if (!seenPaneIds.has(pane.id)) {
      seenPaneIds.add(pane.id);
      return pane;
    }
    const id = paneId(index);
    seenPaneIds.add(id);
    return { ...pane, id };
  });
  const activePaneId = typeof value.activePaneId === "string" && deduplicatedPanes.some((pane) => pane.id === value.activePaneId)
    ? value.activePaneId
    : deduplicatedPanes[0].id;
  return withNormalizedGroups({
    schemaVersion: CHART_WORKSPACE_SCHEMA_VERSION,
    id: normalizeIdentifier(value.id, safe.id),
    name: normalizeText(value.name, safe.name, MAX_LABEL_LENGTH),
    layout: value.layout,
    layoutOrientation: isOrientation(value.layoutOrientation) ? value.layoutOrientation : "horizontal",
    panes: deduplicatedPanes,
    syncGroups: normalizeSyncGroups(value.syncGroups, deduplicatedPanes.map((pane) => pane.id)),
    activePaneId,
  });
}

/** Changes the grid while retaining the leading panes and their configuration. */
export function setChartWorkspaceLayout(
  document: ChartWorkspaceDocument,
  layout: ChartWorkspaceLayout,
  layoutOrientation: ChartWorkspaceOrientation = document.layoutOrientation,
): ChartWorkspaceDocument {
  if (document.layout === layout && document.layoutOrientation === layoutOrientation && document.panes.length === layout) return document;
  const source = document.panes;
  const fallbackPane = source[0] ?? defaultPane(0, DEFAULT_SYMBOL, DEFAULT_TIMEFRAME);
  const panes = Array.from({ length: layout }, (_, index) => {
    const existing = source[index];
    return existing ?? defaultPane(index, fallbackPane.symbol, fallbackPane.timeframe);
  });
  const activePaneId = panes.some((pane) => pane.id === document.activePaneId) ? document.activePaneId : panes[0].id;
  return withNormalizedGroups({ ...document, layout, layoutOrientation, panes, activePaneId });
}

/** Removes a detached pane and compacts the remainder into the next valid layout. */
export function removeChartWorkspacePane(document: ChartWorkspaceDocument, paneId: ChartWorkspacePaneId): ChartWorkspaceDocument {
  if (document.panes.length <= 1 || !document.panes.some((pane) => pane.id === paneId)) return document;
  const panes = document.panes.filter((pane) => pane.id !== paneId);
  const layout = panes.length as ChartWorkspaceLayout;
  const activePaneId = panes.some((pane) => pane.id === document.activePaneId) ? document.activePaneId : panes[0]!.id;
  return withNormalizedGroups({ ...document, layout, panes, activePaneId });
}

export function selectChartWorkspacePane(document: ChartWorkspaceDocument, paneId: ChartWorkspacePaneId): ChartWorkspaceDocument {
  return document.panes.some((pane) => pane.id === paneId) && document.activePaneId !== paneId
    ? { ...document, activePaneId: paneId }
    : document;
}

/** Copies the source pane's content into the target without changing its stable pane id. */
export function copyChartWorkspacePane(
  document: ChartWorkspaceDocument,
  sourcePaneId: ChartWorkspacePaneId,
  targetPaneId: ChartWorkspacePaneId,
): ChartWorkspaceDocument {
  if (sourcePaneId === targetPaneId) return document;
  const source = document.panes.find((pane) => pane.id === sourcePaneId);
  const targetExists = document.panes.some((pane) => pane.id === targetPaneId);
  if (!source || !targetExists) return document;
  return {
    ...document,
    panes: document.panes.map((pane) => pane.id === targetPaneId ? {
      ...source,
      id: pane.id,
      indicatorIds: [...source.indicatorIds],
    } : pane),
  };
}

/** Swaps pane content while preserving pane identity, sync membership, and layout slots. */
export function swapChartWorkspacePanes(
  document: ChartWorkspaceDocument,
  firstPaneId: ChartWorkspacePaneId,
  secondPaneId: ChartWorkspacePaneId,
): ChartWorkspaceDocument {
  if (firstPaneId === secondPaneId) return document;
  const first = document.panes.find((pane) => pane.id === firstPaneId);
  const second = document.panes.find((pane) => pane.id === secondPaneId);
  if (!first || !second) return document;
  return {
    ...document,
    panes: document.panes.map((pane) => {
      if (pane.id === first.id) return { ...second, id: first.id, indicatorIds: [...second.indicatorIds] };
      if (pane.id === second.id) return { ...first, id: second.id, indicatorIds: [...first.indicatorIds] };
      return pane;
    }),
  };
}

export function updateChartWorkspaceSyncGroup(
  document: ChartWorkspaceDocument,
  groupId: string,
  patch: Partial<Pick<ChartWorkspaceSyncGroup, "name" | "paneIds" | "settings">>,
): ChartWorkspaceDocument {
  if (!document.syncGroups.some((group) => group.id === groupId)) return document;
  const paneIds = new Set(document.panes.map((pane) => pane.id));
  return withNormalizedGroups({
    ...document,
    syncGroups: document.syncGroups.map((group) => group.id === groupId ? {
      ...group,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.paneIds === undefined ? {} : { paneIds: patch.paneIds.filter((paneId) => paneIds.has(paneId)) }),
      ...(patch.settings === undefined ? {} : { settings: { ...group.settings, ...patch.settings } }),
    } : group),
  });
}

export function togglePaneInChartWorkspaceSyncGroup(
  document: ChartWorkspaceDocument,
  groupId: string,
  paneId: ChartWorkspacePaneId,
): ChartWorkspaceDocument {
  const group = document.syncGroups.find((item) => item.id === groupId);
  if (!group || !document.panes.some((pane) => pane.id === paneId)) return document;
  const paneIds = group.paneIds.includes(paneId)
    ? group.paneIds.filter((item) => item !== paneId)
    : [...group.paneIds, paneId];
  return updateChartWorkspaceSyncGroup(document, groupId, { paneIds });
}

export function primaryChartWorkspaceSyncGroup(document: ChartWorkspaceDocument): ChartWorkspaceSyncGroup {
  return document.syncGroups[0] ?? defaultSyncGroup(document.panes.map((pane) => pane.id));
}
