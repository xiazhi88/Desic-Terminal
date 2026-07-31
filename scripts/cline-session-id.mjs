import { createHash } from "node:crypto";

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_SESSION_ID_LENGTH = 96;

export function toClineRuntimeSessionId(value) {
  const original = String(value || "").trim() || `cline-${Date.now()}`;
  let safe = original
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[. ]+$/g, "");

  if (!safe) safe = "cline-session";
  if (WINDOWS_RESERVED_NAME.test(safe)) safe = `cline-${safe}`;

  const changed = safe !== original || safe.length > MAX_SESSION_ID_LENGTH;
  if (!changed) return safe;

  const hash = createHash("sha256").update(original).digest("hex").slice(0, 10);
  const prefixLength = MAX_SESSION_ID_LENGTH - hash.length - 1;
  const prefix = safe.slice(0, prefixLength).replace(/[. -]+$/g, "") || "cline-session";
  return `${prefix}-${hash}`;
}
