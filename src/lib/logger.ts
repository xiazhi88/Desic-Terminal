import { invoke } from "@tauri-apps/api/core";

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

type LogEntry = {
  time: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  error?: string;
};

const buffer: LogEntry[] = [];
const maxEntries = 500;
let backendLogFailed = false;
let globalContext: Record<string, unknown> = {};
const subscribers = new Set<(entry: LogEntry) => void>();

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function push(entry: LogEntry) {
  const mergedEntry = {
    ...entry,
    context: Object.keys(globalContext).length > 0 || entry.context ? { ...globalContext, ...(entry.context ?? {}) } : undefined
  };
  buffer.push(mergedEntry);
  if (buffer.length > maxEntries) buffer.shift();

  const consoleMethod =
    mergedEntry.level === "error" || mergedEntry.level === "fatal"
      ? console.error
      : mergedEntry.level === "warn"
        ? console.warn
        : console.log;
  consoleMethod(`[${mergedEntry.level}] ${mergedEntry.message}`, mergedEntry.context ?? "", mergedEntry.error ?? "");
  for (const subscriber of subscribers) {
    try {
      subscriber(mergedEntry);
    } catch (error) {
      console.warn("[warn] logger subscriber failed", error);
    }
  }
  void writeBackendLog(mergedEntry);
}

async function writeBackendLog(entry: LogEntry) {
  if (!isTauriRuntime() || backendLogFailed) return;
  try {
    await invoke("frontend_log", {
      entry: {
        level: entry.level,
        message: entry.message,
        error: entry.error,
        context: entry.context,
        timestamp: Date.parse(entry.time) || Date.now()
      }
    });
  } catch (error) {
    backendLogFailed = true;
    console.warn("[warn] frontend log file write disabled", error);
  }
}

function normalizeError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  return String(error);
}

export const logger = {
  setContext(context: Record<string, unknown>) {
    globalContext = Object.fromEntries(
      Object.entries(context).filter(([, value]) => value !== undefined && value !== null && value !== "")
    );
  },
  clearContext() {
    globalContext = {};
  },
  debug(message: string, context?: Record<string, unknown>) {
    push({ time: new Date().toISOString(), level: "debug", message, context });
  },
  info(message: string, context?: Record<string, unknown>) {
    push({ time: new Date().toISOString(), level: "info", message, context });
  },
  warn(message: string, context?: Record<string, unknown>) {
    push({ time: new Date().toISOString(), level: "warn", message, context });
  },
  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    push({ time: new Date().toISOString(), level: "error", message, context, error: normalizeError(error) });
  },
  fatal(message: string, error?: unknown, context?: Record<string, unknown>) {
    push({ time: new Date().toISOString(), level: "fatal", message, context, error: normalizeError(error) });
  },
  recent() {
    return [...buffer];
  },
  subscribe(handler: (entry: LogEntry) => void) {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  }
};

window.addEventListener("error", (event) => {
  logger.error("window.onerror", event.error ?? event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    // Without the stack an error thrown inside a bundled dependency only
    // reports the listener's own position, which says nothing about the caller.
    stack: event.error instanceof Error ? event.error.stack : undefined
  });
});

window.addEventListener("unhandledrejection", (event) => {
  logger.error("unhandled promise rejection", event.reason);
});
