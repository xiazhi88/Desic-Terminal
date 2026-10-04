// 语音输入偏好（仅本机界面偏好，不含任何凭据；转写服务的 Key 在 Rust 侧保存）。
// 参照 visualPreference：localStorage + 自定义事件，多窗口通过 storage 事件同步。

export const VOICE_HOLD_KEYS = ["Backquote", "AltRight", "F8", "F9"] as const;
export type VoiceHoldKey = (typeof VOICE_HOLD_KEYS)[number];

/** 说完之后留给用户核对识别文字、按 Esc 阻止的停顿；0 表示立即执行。 */
export const VOICE_CONFIRM_OPTIONS = [0, 1000, 2000, 3000] as const;
export type VoiceConfirmMs = (typeof VOICE_CONFIRM_OPTIONS)[number];

export const VOICE_PALETTES = ["violet", "orange", "mono"] as const;
export type VoicePaletteName = (typeof VOICE_PALETTES)[number];

export type VoicePreference = {
  enabled: boolean;
  holdKey: VoiceHoldKey;
  confirmMs: VoiceConfirmMs;
  /** 像素伙伴的配色。 */
  palette: VoicePaletteName;
  /** 停靠在屏幕哪一侧。 */
  side: "left" | "right";
  /** 是否偶尔探出头来（关闭后只在被叫醒时出现）。 */
  peek: boolean;
};

const STORAGE_KEY = "desic.voice.preference.v1";
const CHANGE_EVENT = "desic:voice-preference";
export const DEFAULT_VOICE_PREFERENCE: VoicePreference = { enabled: false, holdKey: "Backquote", confirmMs: 2000, palette: "violet", side: "right", peek: true };

export function isVoiceHoldKey(value: unknown): value is VoiceHoldKey {
  return typeof value === "string" && (VOICE_HOLD_KEYS as readonly string[]).includes(value);
}

export function readVoicePreference(): VoicePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VOICE_PREFERENCE;
    const parsed = JSON.parse(raw) as Partial<VoicePreference>;
    return {
      enabled: parsed.enabled === true,
      holdKey: isVoiceHoldKey(parsed.holdKey) ? parsed.holdKey : DEFAULT_VOICE_PREFERENCE.holdKey,
      confirmMs: (VOICE_CONFIRM_OPTIONS as readonly unknown[]).includes(parsed.confirmMs) ? (parsed.confirmMs as VoiceConfirmMs) : DEFAULT_VOICE_PREFERENCE.confirmMs,
      palette: (VOICE_PALETTES as readonly unknown[]).includes(parsed.palette) ? (parsed.palette as VoicePaletteName) : DEFAULT_VOICE_PREFERENCE.palette,
      side: parsed.side === "left" ? "left" : "right",
      peek: parsed.peek !== false,
    };
  } catch {
    return DEFAULT_VOICE_PREFERENCE;
  }
}

export function saveVoicePreference(preference: VoicePreference) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // 本地存储不可用时仍在本次会话内生效。
  }
  window.dispatchEvent(new CustomEvent<VoicePreference>(CHANGE_EVENT, { detail: preference }));
}

export function subscribeVoicePreference(listener: (preference: VoicePreference) => void) {
  const handleChange = (event: Event) => listener((event as CustomEvent<VoicePreference>).detail);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener(readVoicePreference());
  };
  window.addEventListener(CHANGE_EVENT, handleChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}
