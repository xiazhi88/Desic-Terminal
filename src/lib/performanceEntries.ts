type PerformanceEntryMaintenance = Pick<Performance, "clearMarks" | "clearMeasures" | "clearResourceTimings" | "getEntriesByType">;

export function trimDevelopmentPerformanceEntries(
  target: PerformanceEntryMaintenance,
  maxMeasures = 250,
  maxResources = 500
) {
  const measures = target.getEntriesByType("measure").length;
  const resources = target.getEntriesByType("resource").length;
  if (measures > maxMeasures) {
    target.clearMeasures();
    target.clearMarks();
  }
  if (resources > maxResources) target.clearResourceTimings();
  return { measures, resources, clearedMeasures: measures > maxMeasures, clearedResources: resources > maxResources };
}
