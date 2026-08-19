import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logger } from "./logger";

const activeListeners = new Map<string, number>();
const duplicateListenerWarningAt = new Map<string, number>();
const DUPLICATE_LISTENER_WARNING_INTERVAL_MS = 10_000;
const SUSPICIOUS_LISTENER_COUNT = 8;

type TauriEventPluginInternals = {
  unregisterListener: (event: string, eventId: number) => void;
};

const patchedEventInternals = new WeakSet<TauriEventPluginInternals>();

function missingTauriListenerError(error: unknown) {
  return /listeners\[eventId\]\.handlerId|undefined is not an object.*handlerId|cannot read properties of undefined.*handlerId/i
    .test(error instanceof Error ? error.message : String(error));
}

function installIdempotentEventUnregister() {
  const internals = (window as Window & {
    __TAURI_EVENT_PLUGIN_INTERNALS__?: TauriEventPluginInternals;
  }).__TAURI_EVENT_PLUGIN_INTERNALS__;
  if (!internals || patchedEventInternals.has(internals)) return;
  try {
    const unregister = internals.unregisterListener.bind(internals);
    internals.unregisterListener = (event, eventId) => {
      try {
        unregister(event, eventId);
      } catch (error) {
        // HMR can clear the WebView listener table before React cleanup runs.
        // Keep removal idempotent so Tauri can still unregister its backend listener.
        if (!missingTauriListenerError(error)) throw error;
      }
    };
    patchedEventInternals.add(internals);
  } catch (error) {
    logger.warn("tauri listener cleanup patch unavailable", { error: String(error) });
  }
}

function cleanupTauriListener(event: string, unlisten: () => void) {
  try {
    const pending = (unlisten as unknown as () => unknown)();
    if (pending && typeof (pending as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(pending).catch((error) => {
        if (!missingTauriListenerError(error)) {
          logger.warn("tauri listener cleanup failed", { event, error: String(error) });
        }
      });
    }
  } catch (error) {
    if (!missingTauriListenerError(error)) {
      logger.warn("tauri listener cleanup failed", { event, error: String(error) });
    }
  }
}

installIdempotentEventUnregister();

function updateListenerCount(event: string, delta: number) {
  const next = Math.max(0, (activeListeners.get(event) ?? 0) + delta);
  if (next === 0) activeListeners.delete(event);
  else activeListeners.set(event, next);
  if (import.meta.env.DEV && next > SUSPICIOUS_LISTENER_COUNT) {
    const now = Date.now();
    const lastWarningAt = duplicateListenerWarningAt.get(event) ?? 0;
    if (now - lastWarningAt >= DUPLICATE_LISTENER_WARNING_INTERVAL_MS) {
      duplicateListenerWarningAt.set(event, now);
      logger.warn("duplicate tauri listeners detected", { event, count: next });
    }
  }
}

export function getActiveTauriListenerCounts() {
  return Object.fromEntries(activeListeners);
}

export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export async function loadUiPreferences() {
  return invokeOptional<import("../types").UiPreferencesSummary>("ui_preferences_summary", {
    request: { systemLocale: navigator.languages?.[0] || navigator.language || "en-US" }
  });
}

export async function saveUiPreferences(language: import("../types").LanguagePreference) {
  return invokeDesktop<import("../types").UiPreferencesSummary>("save_ui_preferences", {
    request: { language, systemLocale: navigator.languages?.[0] || navigator.language || "en-US" }
  });
}

export async function loadAppUpdateStatus() {
  return invokeOptional<import("../types").AppUpdateState>("app_update_status");
}

export async function checkAppUpdate() {
  return invokeDesktop<import("../types").AppUpdateState>("app_update_check");
}

export async function prepareAppUpdate() {
  return invokeDesktop<import("../types").AppUpdateBackup>("app_update_prepare");
}

export async function installAppUpdate() {
  return invokeDesktop<void>("app_update_install");
}

export async function applySourceAppUpdate() {
  return invokeDesktop<import("../types").AppUpdateState>("app_update_apply_source");
}

export async function restartAfterSourceAppUpdate() {
  return invokeDesktop<void>("app_update_restart_source");
}

export async function invokeOptional<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    logger.error(`tauri command failed, falling back when possible: ${command}`, error);
    return null;
  }
}

export async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    logger.error(`tauri command failed: ${command}`, error);
    throw error;
  }
}

export async function listenOptional<T>(event: string, handler: (payload: T) => void): Promise<(() => void) | null> {
  if (!isTauriRuntime()) return null;
  try {
    installIdempotentEventUnregister();
    const unlisten = await listen<T>(event, (message) => handler(message.payload));
    let active = true;
    updateListenerCount(event, 1);
    return () => {
      if (!active) return;
      active = false;
      updateListenerCount(event, -1);
      cleanupTauriListener(event, unlisten);
    };
  } catch (error) {
    logger.error(`tauri listen failed: ${event}`, error);
    return null;
  }
}
