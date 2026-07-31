/**
 * Versioned, renderer-independent drawing objects for all chart surfaces.
 *
 * This domain model intentionally contains no SVG, canvas, or trading action.
 * A chart renderer can derive its own coordinates from `time` and `price`.
 */

export const CHART_DRAWING_SCHEMA_VERSION = 1 as const;
export const CHART_DRAWING_TEMPLATE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CHART_DRAWING_TEMPLATE_STORAGE_KEY = "desic.chart-drawing-templates.v1";

export type ChartDrawingKind =
  | "trend"
  | "ray"
  | "horizontal"
  | "vertical"
  | "rect"
  | "fibRetracement"
  | "fibExtension"
  | "parallelChannel"
  | "text"
  | "arrow"
  | "priceLabel"
  | "riskReward";

export type ChartDrawingLineStyle = "solid" | "dashed" | "dotted";
export type ChartDrawingArrowDirection = "up" | "down" | "left" | "right";
export type ChartRiskRewardDirection = "long" | "short";

export type ChartDrawingAnchor = Readonly<{
  time: number;
  price: number;
  /** Index is optional because a drawing can be restored before candles load. */
  index: number | null;
}>;

export type ChartDrawingStyle = Readonly<{
  color: string;
  lineStyle: ChartDrawingLineStyle;
  lineWidth: number;
  fillColor: string | null;
  fillOpacity: number;
}>;

export type ChartDrawingSettings = Readonly<{
  text: string | null;
  textAlign: "left" | "center" | "right";
  arrowDirection: ChartDrawingArrowDirection | null;
  fibLevels: readonly number[];
  extendLeft: boolean;
  extendRight: boolean;
  riskRewardDirection: ChartRiskRewardDirection | null;
  riskAmount: number | null;
  showPrice: boolean;
}>;

export type ChartDrawingObject = Readonly<{
  schemaVersion: typeof CHART_DRAWING_SCHEMA_VERSION;
  id: string;
  kind: ChartDrawingKind;
  anchors: readonly ChartDrawingAnchor[];
  paneId: string;
  style: ChartDrawingStyle;
  settings: ChartDrawingSettings;
  locked: boolean;
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
}>;

export type ChartDrawingDocument = Readonly<{
  schemaVersion: typeof CHART_DRAWING_SCHEMA_VERSION;
  drawings: readonly ChartDrawingObject[];
  updatedAt: number;
}>;

export type ChartDrawingTemplate = Readonly<{
  schemaVersion: typeof CHART_DRAWING_TEMPLATE_SCHEMA_VERSION;
  id: string;
  name: string;
  drawings: readonly ChartDrawingObject[];
  createdAt: number;
  updatedAt: number;
}>;

export type ChartDrawingParseResult = Readonly<{
  document: ChartDrawingDocument;
  issues: readonly string[];
  source: "current" | "legacy" | "fallback";
}>;

export type ChartDrawingValidation = Readonly<{
  valid: boolean;
  issues: readonly string[];
  drawing: ChartDrawingObject | null;
}>;

export type ApplyChartDrawingTemplateOptions = Readonly<{
  mode?: "append" | "replace";
  now?: number;
  paneId?: string;
}>;

const MAX_DRAWINGS = 500;
const MAX_TEMPLATE_COUNT = 80;
const MAX_ANCHORS = 4;
const MAX_TEXT_LENGTH = 800;
const MAX_IDENTIFIER_LENGTH = 96;
const MAX_TEMPLATE_NAME_LENGTH = 64;
const DEFAULT_FIB_LEVELS = Object.freeze([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);

const DEFAULT_STYLE: ChartDrawingStyle = Object.freeze({
  color: "#a78bfa",
  lineStyle: "solid",
  lineWidth: 1,
  fillColor: null,
  fillOpacity: 0.12,
});

const DEFAULT_SETTINGS: ChartDrawingSettings = Object.freeze({
  text: null,
  textAlign: "left",
  arrowDirection: null,
  fibLevels: DEFAULT_FIB_LEVELS,
  extendLeft: false,
  extendRight: false,
  riskRewardDirection: null,
  riskAmount: null,
  showPrice: true,
});

const LEGACY_KIND_MAP: Readonly<Record<string, ChartDrawingKind>> = Object.freeze({
  trend: "trend",
  ray: "ray",
  horizontal: "horizontal",
  vertical: "vertical",
  rect: "rect",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDrawingKind(value: unknown): value is ChartDrawingKind {
  return typeof value === "string" && [
    "trend", "ray", "horizontal", "vertical", "rect", "fibRetracement",
    "fibExtension", "parallelChannel", "text", "arrow", "priceLabel", "riskReward",
  ].includes(value);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeTimestamp(value: unknown, fallback: number) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}

function safeIdentifier(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().slice(0, MAX_IDENTIFIER_LENGTH).replace(/[^A-Za-z0-9._:-]/g, "-");
  return normalized || fallback;
}

function safeText(value: unknown, maximum = MAX_TEXT_LENGTH) {
  return typeof value === "string" ? value.trim().slice(0, maximum) || null : null;
}

function safeColor(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string") return fallback;
  const color = value.trim().slice(0, 48);
  // Kept intentionally strict: colors become renderer inputs, not arbitrary CSS.
  return /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s]+\)|transparent)$/.test(color) ? color : fallback;
}

function normalizeAnchor(value: unknown): ChartDrawingAnchor | null {
  if (!isRecord(value)) return null;
  const time = finite(value.time, Number.NaN);
  const price = finite(value.price, Number.NaN);
  if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(price) || price <= 0) return null;
  const index = typeof value.index === "number" && Number.isFinite(value.index) && value.index >= 0
    ? Math.floor(value.index)
    : null;
  return { time: Math.floor(time), price, index };
}

function normalizeAnchors(value: unknown): readonly ChartDrawingAnchor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const anchor = normalizeAnchor(candidate);
    return anchor ? [anchor] : [];
  }).slice(0, MAX_ANCHORS);
}

function normalizeStyle(value: unknown): ChartDrawingStyle {
  const source = isRecord(value) ? value : {};
  return {
    color: safeColor(source.color, DEFAULT_STYLE.color) ?? DEFAULT_STYLE.color,
    lineStyle: source.lineStyle === "dashed" || source.lineStyle === "dotted" ? source.lineStyle : "solid",
    lineWidth: clamp(finite(source.lineWidth, DEFAULT_STYLE.lineWidth), 1, 8),
    fillColor: safeColor(source.fillColor, null),
    fillOpacity: clamp(finite(source.fillOpacity, DEFAULT_STYLE.fillOpacity), 0, 0.85),
  };
}

function normalizeFibLevels(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [...DEFAULT_FIB_LEVELS];
  const levels = [...new Set(value
    .filter((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate))
    .map((candidate) => Math.round(candidate * 100_000) / 100_000)
    .filter((candidate) => candidate >= -10 && candidate <= 10))]
    .sort((left, right) => left - right)
    .slice(0, 32);
  return levels.length > 0 ? levels : [...DEFAULT_FIB_LEVELS];
}

function normalizeSettings(value: unknown): ChartDrawingSettings {
  const source = isRecord(value) ? value : {};
  return {
    text: safeText(source.text),
    textAlign: source.textAlign === "center" || source.textAlign === "right" ? source.textAlign : "left",
    arrowDirection: source.arrowDirection === "up" || source.arrowDirection === "down" || source.arrowDirection === "left" || source.arrowDirection === "right"
      ? source.arrowDirection
      : null,
    fibLevels: normalizeFibLevels(source.fibLevels),
    extendLeft: source.extendLeft === true,
    extendRight: source.extendRight === true,
    riskRewardDirection: source.riskRewardDirection === "long" || source.riskRewardDirection === "short" ? source.riskRewardDirection : null,
    riskAmount: typeof source.riskAmount === "number" && Number.isFinite(source.riskAmount) && source.riskAmount > 0
      ? source.riskAmount
      : null,
    showPrice: source.showPrice !== false,
  };
}

function requiredAnchorCount(kind: ChartDrawingKind) {
  if (kind === "fibExtension" || kind === "parallelChannel" || kind === "riskReward") return 3;
  if (kind === "text" || kind === "arrow" || kind === "priceLabel") return 1;
  return 2;
}

function drawingIssues(kind: ChartDrawingKind, anchors: readonly ChartDrawingAnchor[], settings: ChartDrawingSettings): string[] {
  const issues: string[] = [];
  const expected = requiredAnchorCount(kind);
  if (anchors.length !== expected) issues.push(`${kind} 需要 ${expected} 个锚点。`);
  if ((kind === "text" || kind === "priceLabel") && !settings.text) issues.push(`${kind} 需要文本内容。`);
  if (kind === "arrow" && !settings.arrowDirection) issues.push("arrow 需要方向。");
  if (kind === "riskReward" && !settings.riskRewardDirection) issues.push("riskReward 需要多空方向。");
  return issues;
}

function createId(prefix = "drawing") {
  const uuid = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2, 12);
  return `${prefix}-${Date.now().toString(36)}-${uuid}`.slice(0, MAX_IDENTIFIER_LENGTH);
}

function normalizeDrawing(value: unknown, fallbackNow = Date.now()): ChartDrawingValidation {
  if (!isRecord(value)) return { valid: false, issues: ["绘图对象必须是对象。"], drawing: null };
  const kind = isDrawingKind(value.kind) ? value.kind : LEGACY_KIND_MAP[String(value.tool)] ?? null;
  if (!kind) return { valid: false, issues: ["未知绘图类型。"], drawing: null };
  const anchors = Array.isArray(value.anchors)
    ? normalizeAnchors(value.anchors)
    : normalizeAnchors([value.start, value.end]);
  const settings = normalizeSettings(value.settings);
  const now = safeTimestamp(fallbackNow, Date.now());
  const drawing: ChartDrawingObject = {
    schemaVersion: CHART_DRAWING_SCHEMA_VERSION,
    id: safeIdentifier(value.id, createId()),
    kind,
    anchors,
    paneId: safeIdentifier(value.paneId, "main"),
    style: normalizeStyle({
      ...(!isRecord(value.style) ? {} : value.style),
      color: isRecord(value.style) ? value.style.color : value.color,
      lineStyle: isRecord(value.style) ? value.style.lineStyle : value.lineStyle,
    }),
    settings,
    locked: value.locked === true,
    hidden: value.hidden === true,
    createdAt: safeTimestamp(value.createdAt, now),
    updatedAt: safeTimestamp(value.updatedAt, now),
  };
  const issues = drawingIssues(kind, anchors, settings);
  return { valid: issues.length === 0, issues, drawing };
}

export function validateChartDrawing(value: unknown): ChartDrawingValidation {
  return normalizeDrawing(value);
}

export function createChartDrawing(
  kind: ChartDrawingKind,
  anchors: readonly ChartDrawingAnchor[],
  patch: Partial<Omit<ChartDrawingObject, "schemaVersion" | "id" | "kind" | "anchors" | "createdAt" | "updatedAt">> = {},
  now = Date.now(),
): ChartDrawingValidation {
  return normalizeDrawing({
    ...patch,
    id: createId(),
    kind,
    anchors,
    createdAt: now,
    updatedAt: now,
  }, now);
}

/** Parses current documents and legacy KlineChart `{ tool, start, end }` objects. */
export function parseChartDrawingDocument(value: unknown, fallbackNow = Date.now()): ChartDrawingParseResult {
  const source = Array.isArray(value)
    ? { drawings: value, schemaVersion: "legacy" }
    : isRecord(value) ? value
    : null;
  if (!source) return { document: { schemaVersion: CHART_DRAWING_SCHEMA_VERSION, drawings: [], updatedAt: fallbackNow }, issues: ["绘图文档无效。"], source: "fallback" };

  const rawDrawings = Array.isArray(source.drawings) ? source.drawings : [];
  const seen = new Set<string>();
  const issues: string[] = [];
  const drawings = rawDrawings.flatMap((candidate, index): ChartDrawingObject[] => {
    const parsed = normalizeDrawing(candidate, fallbackNow);
    if (!parsed.drawing) {
      issues.push(...parsed.issues.map((issue) => `绘图 ${index + 1}：${issue}`));
      return [];
    }
    if (seen.has(parsed.drawing.id)) {
      issues.push(`绘图 ${index + 1}：ID 重复，已忽略。`);
      return [];
    }
    seen.add(parsed.drawing.id);
    if (!parsed.valid) issues.push(...parsed.issues.map((issue) => `绘图 ${index + 1}：${issue}`));
    return parsed.valid ? [parsed.drawing] : [];
  }).slice(0, MAX_DRAWINGS);

  return {
    document: {
      schemaVersion: CHART_DRAWING_SCHEMA_VERSION,
      drawings,
      updatedAt: safeTimestamp(source.updatedAt, fallbackNow),
    },
    issues,
    source: source.schemaVersion === CHART_DRAWING_SCHEMA_VERSION ? "current" : source.schemaVersion === "legacy" ? "legacy" : "fallback",
  };
}

export function serializeChartDrawingDocument(document: ChartDrawingDocument): string {
  return JSON.stringify(parseChartDrawingDocument(document).document);
}

function normalizeTemplate(value: unknown, fallbackNow = Date.now()): ChartDrawingTemplate | null {
  if (!isRecord(value) || value.schemaVersion !== CHART_DRAWING_TEMPLATE_SCHEMA_VERSION) return null;
  const parsed = parseChartDrawingDocument({ schemaVersion: CHART_DRAWING_SCHEMA_VERSION, drawings: value.drawings, updatedAt: value.updatedAt }, fallbackNow);
  const createdAt = safeTimestamp(value.createdAt, fallbackNow);
  return {
    schemaVersion: CHART_DRAWING_TEMPLATE_SCHEMA_VERSION,
    id: safeIdentifier(value.id, `drawing-template-${createdAt}`),
    name: safeText(value.name, MAX_TEMPLATE_NAME_LENGTH) ?? "未命名绘图模板",
    drawings: parsed.document.drawings,
    createdAt,
    updatedAt: safeTimestamp(value.updatedAt, createdAt),
  };
}

export function createChartDrawingTemplate(name: string, drawings: readonly ChartDrawingObject[], now = Date.now()): ChartDrawingTemplate {
  const safeNow = safeTimestamp(now, Date.now());
  const document = parseChartDrawingDocument({ schemaVersion: CHART_DRAWING_SCHEMA_VERSION, drawings, updatedAt: safeNow }, safeNow).document;
  return {
    schemaVersion: CHART_DRAWING_TEMPLATE_SCHEMA_VERSION,
    id: createId("drawing-template"),
    name: safeText(name, MAX_TEMPLATE_NAME_LENGTH) ?? "未命名绘图模板",
    drawings: document.drawings,
    createdAt: safeNow,
    updatedAt: safeNow,
  };
}

function readTemplates(storageKey: string): unknown[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    const decoded: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(decoded) ? decoded : [];
  } catch {
    return [];
  }
}

function writeTemplates(storageKey: string, templates: readonly ChartDrawingTemplate[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(templates));
  } catch {
    // Templates remain usable in the current session if browser storage is unavailable.
  }
}

export function loadChartDrawingTemplates(storageKey = DEFAULT_CHART_DRAWING_TEMPLATE_STORAGE_KEY): ChartDrawingTemplate[] {
  const seen = new Set<string>();
  return readTemplates(storageKey)
    .flatMap((value) => {
      const template = normalizeTemplate(value);
      if (!template || seen.has(template.id)) return [];
      seen.add(template.id);
      return [template];
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_TEMPLATE_COUNT);
}

export function saveChartDrawingTemplate(
  template: ChartDrawingTemplate,
  storageKey = DEFAULT_CHART_DRAWING_TEMPLATE_STORAGE_KEY,
): ChartDrawingTemplate[] {
  const normalized = normalizeTemplate(template);
  if (!normalized) return loadChartDrawingTemplates(storageKey);
  const next = [normalized, ...loadChartDrawingTemplates(storageKey).filter((item) => item.id !== normalized.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_TEMPLATE_COUNT);
  writeTemplates(storageKey, next);
  return next;
}

export function deleteChartDrawingTemplate(id: string, storageKey = DEFAULT_CHART_DRAWING_TEMPLATE_STORAGE_KEY): ChartDrawingTemplate[] {
  const next = loadChartDrawingTemplates(storageKey).filter((template) => template.id !== id);
  writeTemplates(storageKey, next);
  return next;
}

/**
 * Clones template objects with fresh IDs. `append` keeps active drawings;
 * `replace` is useful for a clean analysis view. Symbols are never stored.
 */
export function applyChartDrawingTemplate(
  current: readonly ChartDrawingObject[],
  template: ChartDrawingTemplate,
  options: ApplyChartDrawingTemplateOptions = {},
): ChartDrawingObject[] {
  const normalized = normalizeTemplate(template);
  if (!normalized) return [...current];
  const now = safeTimestamp(options.now, Date.now());
  const paneId = options.paneId ? safeIdentifier(options.paneId, "main") : null;
  const clones = normalized.drawings.map((drawing) => ({
    ...drawing,
    id: createId(),
    paneId: paneId ?? drawing.paneId,
    anchors: drawing.anchors.map((anchor) => ({ ...anchor })),
    style: { ...drawing.style },
    settings: { ...drawing.settings, fibLevels: [...drawing.settings.fibLevels] },
    createdAt: now,
    updatedAt: now,
  }));
  const base = options.mode === "replace" ? [] : current;
  return [...parseChartDrawingDocument({
    schemaVersion: CHART_DRAWING_SCHEMA_VERSION,
    drawings: [...base, ...clones],
    updatedAt: now,
  }, now).document.drawings];
}
