import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { invokeDesktop, invokeOptional, isTauriRuntime, listenOptional } from "../lib/tauri";
import { installLegacyI18nBridge } from "./legacyBridge";
import {
  intelligenceLanguage,
  isLanguagePreference,
  isSupportedLocale,
  preferredSystemLocale,
  resolveLocale,
  type LanguagePreference,
  type SupportedLocale,
  type UiPreferencesSummary
} from "./locales";
import { I18N_NAMESPACES, I18N_RESOURCES } from "./resources";

const LANGUAGE_CACHE_KEY = "desic.ui.language.v1";
const DISPLAY_TIME_ZONE = "Asia/Shanghai";

let initialization: Promise<UiPreferencesSummary> | null = null;
let currentPreference: LanguagePreference = "system";
let removeLocaleListener: (() => void) | null = null;

function cachedPreference(): LanguagePreference {
  if (typeof localStorage === "undefined") return "system";
  try {
    const value = localStorage.getItem(LANGUAGE_CACHE_KEY);
    return isLanguagePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

function cachePreference(value: LanguagePreference) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LANGUAGE_CACHE_KEY, value);
  } catch {
    // The Tauri preference remains authoritative when browser storage is unavailable.
  }
}

function normalizeSummary(value: UiPreferencesSummary | null | undefined): UiPreferencesSummary {
  const language = isLanguagePreference(value?.language) ? value.language : currentPreference;
  const resolvedLanguage = isSupportedLocale(value?.resolvedLanguage)
    ? value.resolvedLanguage
    : resolveLocale(language);
  return { language, resolvedLanguage };
}

async function applySummary(summary: UiPreferencesSummary) {
  currentPreference = summary.language;
  cachePreference(summary.language);
  if (i18n.language !== summary.resolvedLanguage) await i18n.changeLanguage(summary.resolvedLanguage);
  if (typeof document !== "undefined") {
    document.documentElement.lang = summary.resolvedLanguage;
    document.documentElement.dir = "ltr";
    document.documentElement.dataset.locale = summary.resolvedLanguage;
  }
  return summary;
}

export function initializeI18n(): Promise<UiPreferencesSummary> {
  if (initialization) return initialization;
  initialization = (async () => {
    currentPreference = cachedPreference();
    const initialLocale = resolveLocale(currentPreference);
    if (!i18n.isInitialized) {
      await i18n
        .use(initReactI18next)
        .init({
          resources: I18N_RESOURCES,
          lng: initialLocale,
          fallbackLng: "en-US",
          supportedLngs: Object.keys(I18N_RESOURCES),
          ns: I18N_NAMESPACES,
          defaultNS: "common",
          fallbackNS: "common",
          interpolation: { escapeValue: false },
          returnNull: false,
          react: { useSuspense: false }
        });
    }
    let summary = await applySummary({ language: currentPreference, resolvedLanguage: initialLocale });
    installLegacyI18nBridge();
    if (isTauriRuntime()) {
      const stored = await invokeOptional<UiPreferencesSummary>("ui_preferences_summary", {
        request: { systemLocale: preferredSystemLocale() }
      });
      if (stored) summary = await applySummary(normalizeSummary(stored));
      removeLocaleListener?.();
      removeLocaleListener = await listenOptional<UiPreferencesSummary>("ui:locale-changed", (value) => {
        void applySummary(normalizeSummary(value));
      });
    }
    return summary;
  })();
  return initialization;
}

export async function saveLanguagePreference(language: LanguagePreference) {
  const fallback = normalizeSummary({
    language,
    resolvedLanguage: resolveLocale(language)
  });
  if (!isTauriRuntime()) return applySummary(fallback);
  const stored = await invokeDesktop<UiPreferencesSummary>("save_ui_preferences", {
    request: { language, systemLocale: preferredSystemLocale() }
  });
  return applySummary(normalizeSummary(stored ?? fallback));
}

export function languagePreference() {
  return currentPreference;
}

export function resolvedLocale(): SupportedLocale {
  return isSupportedLocale(i18n.language) ? i18n.language : resolveLocale(currentPreference);
}

export function formatLocalizedDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = {}
) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(resolvedLocale(), {
    timeZone: DISPLAY_TIME_ZONE,
    ...options
  }).format(date);
}

export function formatLocalizedNumber(value: number, options: Intl.NumberFormatOptions = {}) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(resolvedLocale(), options).format(value);
}

export function formatTradingNumber(value: number, options: Intl.NumberFormatOptions = {}) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", options).format(value);
}

export { i18n };
export { intelligenceLanguage } from "./locales";
