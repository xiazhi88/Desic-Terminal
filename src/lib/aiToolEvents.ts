const INTERNAL_TOOL_EXECUTION_POLICY = "rust:tool-execute-request";

type AiToolEventRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AiToolEventRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function filterInternalAiToolEvents(events: unknown[]): AiToolEventRecord[] {
  const records = events.filter(isRecord);
  const internalCallIds = new Set(
    records
      .filter((event) => event.type === "toolCall" && event.policy === INTERNAL_TOOL_EXECUTION_POLICY)
      .map((event) => event.toolCallId)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
  if (internalCallIds.size === 0) return records;
  return records.filter((event) => {
    if (event.type !== "toolCall" && event.type !== "toolResult") return true;
    return typeof event.toolCallId !== "string" || !internalCallIds.has(event.toolCallId);
  });
}
