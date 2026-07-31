export type ChartIndicatorTemplate = {
  id: string;
  name: string;
  indicatorIds: string[];
  createdAt: number;
};

const STORAGE_KEY = "desic.chart.indicator-templates.v1";

export function loadChartIndicatorTemplates(): ChartIndicatorTemplate[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): ChartIndicatorTemplate[] => {
      if (!item || typeof item !== "object") return [];
      const source = item as Partial<ChartIndicatorTemplate>;
      const name = typeof source.name === "string" ? source.name.trim().slice(0, 48) : "";
      const ids = Array.isArray(source.indicatorIds) ? [...new Set(source.indicatorIds.filter((id): id is string => typeof id === "string"))].slice(0, 32) : [];
      if (!name) return [];
      return [{ id: typeof source.id === "string" ? source.id : `indicator-template-${Date.now()}`, name, indicatorIds: ids, createdAt: Number(source.createdAt) || Date.now() }];
    });
  } catch {
    return [];
  }
}

export function saveChartIndicatorTemplates(templates: readonly ChartIndicatorTemplate[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates.slice(0, 30)));
}

export function createChartIndicatorTemplate(name: string, indicatorIds: readonly string[]): ChartIndicatorTemplate | null {
  const normalized = name.trim().slice(0, 48);
  if (!normalized) return null;
  return {
    id: `indicator-template-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: normalized,
    indicatorIds: [...new Set(indicatorIds)].slice(0, 32),
    createdAt: Date.now(),
  };
}
