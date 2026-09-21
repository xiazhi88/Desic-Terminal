/**
 * Presentation helpers for the WSS status tooltip.
 *
 * `delayMs` and `lastReceivedAt` both describe how old the same stream is, so
 * the previous `delayMs + receivedAge` double-counted the age and made a healthy
 * stream look seconds slower than it was. Trades and the local queue lag are
 * reported beside the ticker age instead of being folded into it.
 */
export type PublicStreamAgeInput = {
  eventAt?: number | null;
  lastReceivedAt?: number | null;
  delayMs?: number | null;
  tradesDelayMs?: number | null;
  queueLagMs?: number | null;
};

/** Current age of a public stream in ms, or undefined when nothing is known. */
export function publicStreamAgeMs(
  status: PublicStreamAgeInput,
  clockTick: number
): number | undefined {
  const hasDelay = typeof status.delayMs === "number" && Number.isFinite(status.delayMs);
  const hasReceivedAt =
    typeof status.lastReceivedAt === "number" && Number.isFinite(status.lastReceivedAt);
  if (!hasDelay && !hasReceivedAt) return undefined;
  const delayAge = hasDelay ? Math.max(0, status.delayMs as number) : 0;
  const receivedAge = hasReceivedAt ? Math.max(0, clockTick - (status.lastReceivedAt as number)) : 0;
  return Math.max(delayAge, receivedAge);
}

/** Local queue lag worth showing: only reported once it is actually visible. */
export function publicStreamQueueLagMs(status: PublicStreamAgeInput): number | undefined {
  const value = status.queueLagMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 500 ? value : undefined;
}

/** `成交 1.20s · 本地排队 3.00s`, or undefined when there is nothing to add. */
export function formatPublicStreamChannelNote(
  status: PublicStreamAgeInput,
  fmtDelay: (ms?: number) => string,
  labels: { trades: string; queue: string }
): string | undefined {
  const parts: string[] = [];
  if (typeof status.tradesDelayMs === "number" && Number.isFinite(status.tradesDelayMs)) {
    parts.push(`${labels.trades} ${fmtDelay(status.tradesDelayMs)}`);
  }
  const queueLag = publicStreamQueueLagMs(status);
  if (queueLag !== undefined) parts.push(`${labels.queue} ${fmtDelay(queueLag)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
