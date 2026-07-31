export const SUPPORTED_LOCALES = [
  "zh-CN",
  "zh-TW",
  "en-US",
  "ja-JP",
  "ko-KR",
  "de-DE",
  "fr-FR",
  "es-ES",
  "pt-BR",
  "ru-RU"
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LanguagePreference = "system" | SupportedLocale;

export type UiPreferencesSummary = {
  language: LanguagePreference;
  resolvedLanguage: SupportedLocale;
};

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  value: LanguagePreference;
  nativeLabel: string;
  englishLabel: string;
}> = [
  { value: "system", nativeLabel: "System", englishLabel: "Follow operating system" },
  { value: "zh-CN", nativeLabel: "简体中文", englishLabel: "Simplified Chinese" },
  { value: "zh-TW", nativeLabel: "繁體中文", englishLabel: "Traditional Chinese" },
  { value: "en-US", nativeLabel: "English", englishLabel: "English" },
  { value: "ja-JP", nativeLabel: "日本語", englishLabel: "Japanese" },
  { value: "ko-KR", nativeLabel: "한국어", englishLabel: "Korean" },
  { value: "de-DE", nativeLabel: "Deutsch", englishLabel: "German" },
  { value: "fr-FR", nativeLabel: "Français", englishLabel: "French" },
  { value: "es-ES", nativeLabel: "Español", englishLabel: "Spanish" },
  { value: "pt-BR", nativeLabel: "Português (Brasil)", englishLabel: "Portuguese (Brazil)" },
  { value: "ru-RU", nativeLabel: "Русский", englishLabel: "Russian" }
];

const SUPPORTED_SET = new Set<string>(SUPPORTED_LOCALES);

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && SUPPORTED_SET.has(value);
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || isSupportedLocale(value);
}

function normalizeLocaleTag(value: string) {
  return value.trim().replace(/_/g, "-");
}

export function matchSupportedLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;
  const normalized = normalizeLocaleTag(value);
  if (isSupportedLocale(normalized)) return normalized;
  const lower = normalized.toLowerCase();
  if (lower === "zh-hant" || lower.startsWith("zh-hant-") || lower.startsWith("zh-tw") || lower.startsWith("zh-hk") || lower.startsWith("zh-mo")) return "zh-TW";
  if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";
  if (lower === "pt" || lower.startsWith("pt-")) return "pt-BR";
  if (lower === "en" || lower.startsWith("en-")) return "en-US";
  if (lower === "ja" || lower.startsWith("ja-")) return "ja-JP";
  if (lower === "ko" || lower.startsWith("ko-")) return "ko-KR";
  if (lower === "de" || lower.startsWith("de-")) return "de-DE";
  if (lower === "fr" || lower.startsWith("fr-")) return "fr-FR";
  if (lower === "es" || lower.startsWith("es-")) return "es-ES";
  if (lower === "ru" || lower.startsWith("ru-")) return "ru-RU";
  return null;
}

export function resolveLocale(
  preference: LanguagePreference,
  systemLocales: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages
): SupportedLocale {
  if (preference !== "system") return preference;
  for (const locale of systemLocales) {
    const matched = matchSupportedLocale(locale);
    if (matched) return matched;
  }
  return "en-US";
}

export function preferredSystemLocale() {
  if (typeof navigator === "undefined") return "en-US";
  return navigator.languages.find(Boolean) || navigator.language || "en-US";
}

export function intelligenceLanguage(locale: SupportedLocale): "zh-CN" | "en-US" {
  return locale === "zh-CN" || locale === "zh-TW" ? "zh-CN" : "en-US";
}
