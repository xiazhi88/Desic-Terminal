import { formatLocalizedNumber } from "../i18n/runtime";

export function fmtPrice(value?: string | number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: n > 100 ? 1 : 5 });
}

export function fmtCompact(value?: string | number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return formatLocalizedNumber(n, { notation: "compact", maximumFractionDigits: 2 });
}

export function calcChange(last?: string, open?: string) {
  const l = Number(last);
  const o = Number(open);
  if (!Number.isFinite(l) || !Number.isFinite(o) || o === 0) return 0;
  return ((l - o) / o) * 100;
}

export function fmtDelay(delayMs?: number) {
  if (delayMs == null || !Number.isFinite(delayMs)) return "--";
  if (delayMs < 1000) return `${Math.max(0, Math.round(delayMs))}ms`;
  return `${(delayMs / 1000).toFixed(2)}s`;
}
