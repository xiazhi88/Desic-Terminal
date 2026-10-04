// 用户纠错词表的本机存储（只含用户自己的改动，不含任何凭据）。参照 voicePreference：localStorage + 事件，多窗口同步。
import { mergeEntry, sanitizeEntries, type LexiconEntry } from "./lexicon";

const STORAGE_KEY = "desic.voice.lexicon.v1";
const CHANGE_EVENT = "desic:voice-lexicon";

export function readLexicon(): LexiconEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeEntries(JSON.parse(raw) as unknown[]) : [];
  } catch {
    return [];
  }
}

export function saveLexicon(entries: readonly LexiconEntry[]) {
  const clean = sanitizeEntries(entries);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // 本地存储不可用时仍在本次会话内生效。
  }
  window.dispatchEvent(new CustomEvent<LexiconEntry[]>(CHANGE_EVENT, { detail: clean }));
}

export function addLexiconEntry(entry: LexiconEntry): LexiconEntry[] {
  const next = mergeEntry(readLexicon(), entry);
  saveLexicon(next);
  return next;
}

export function subscribeLexicon(listener: (entries: LexiconEntry[]) => void) {
  const handleChange = (event: Event) => listener((event as CustomEvent<LexiconEntry[]>).detail);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener(readLexicon());
  };
  window.addEventListener(CHANGE_EVENT, handleChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}
