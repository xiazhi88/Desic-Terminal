/**
 * 语音纠错词表：识别结果先按词表替换，再交给解析器。
 *
 * 为什么不是模型热词：热词偏置要额外的词表文件，且在没有真人录音的情况下无法评估好坏；
 * 纠错词表是确定性的，并且能从用户自己的改动里学习（停顿期按 Tab 改字 → 学出一条）。
 * 不依赖 React / Tauri，可直接用 node 测试。
 */

export type LexiconEntry = { from: string; to: string };

/** 内置的、几乎不会误伤的常见误识别。用户词表优先于内置词表。 */
export const DEFAULT_CORRECTIONS: readonly LexiconEntry[] = [
  { from: "布灵带", to: "布林带" },
  { from: "布令带", to: "布林带" },
  { from: "布灵", to: "布林" },
  { from: "不林", to: "布林" },
  { from: "定单流", to: "订单流" },
  { from: "订单留", to: "订单流" },
  { from: "以太方", to: "以太坊" },
  { from: "依太坊", to: "以太坊" },
  { from: "一太坊", to: "以太坊" },
  { from: "比特比", to: "比特币" },
  { from: "必特币", to: "比特币" },
  { from: "索拉那", to: "索拉纳" },
  { from: "撤消", to: "撤销" },
  { from: "麦克迪", to: "MACD" },
  { from: "艾玛", to: "EMA" },
];

const MAX_USER_ENTRIES = 200;
const MAX_FIELD = 24;

function clean(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function sanitizeEntries(entries: readonly unknown[]): LexiconEntry[] {
  const seen = new Set<string>();
  const out: LexiconEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const from = typeof (raw as LexiconEntry).from === "string" ? clean((raw as LexiconEntry).from) : "";
    const to = typeof (raw as LexiconEntry).to === "string" ? clean((raw as LexiconEntry).to) : "";
    if (!from || !to || from === to || from.length > MAX_FIELD || to.length > MAX_FIELD) continue;
    const key = from.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to });
    if (out.length >= MAX_USER_ENTRIES) break;
  }
  return out;
}

/** 「R S I」「M A C D」这类逐字母读出的指标名合并成一个词。只合并大写字母（识别引擎把读出的字母输出为大写），小写的 "a b" 不动。 */
export function joinSpacedLetters(text: string): string {
  return text.replace(/(?<![A-Za-z])(?:[A-Z] ){1,}[A-Z](?![A-Za-z])/g, (match) => match.replace(/ /g, ""));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type CorrectionResult = { text: string; changes: LexiconEntry[] };

/** 应用词表：先合并逐字母，再按「长的优先」逐条替换；ASCII 词不区分大小写且按词边界匹配。 */
export function applyCorrections(text: string, userEntries: readonly LexiconEntry[] = []): CorrectionResult {
  const changes: LexiconEntry[] = [];
  let out = text.normalize("NFKC");
  const joined = joinSpacedLetters(out);
  if (joined !== out) {
    changes.push({ from: out, to: joined });
    out = joined;
  }
  const entries = [...sanitizeEntries(userEntries), ...DEFAULT_CORRECTIONS].sort((a, b) => b.from.length - a.from.length);
  for (const entry of entries) {
    const ascii = /^[\x20-\x7e]+$/.test(entry.from);
    const pattern = new RegExp(ascii ? `(?<![A-Za-z0-9])${escapeRegExp(entry.from)}(?![A-Za-z0-9])` : escapeRegExp(entry.from), ascii ? "gi" : "g");
    if (!pattern.test(out)) continue;
    pattern.lastIndex = 0;
    out = out.replace(pattern, entry.to);
    changes.push(entry);
  }
  return { text: out, changes };
}

/**
 * 从「识别结果 → 用户改过的文字」里学出一条纠错：去掉共同的前缀和后缀，剩下的中间段就是被听错的部分。
 * 中间段太长（多半是整句重写）或为空时不学。
 */
export function learnCorrection(original: string, edited: string): LexiconEntry | null {
  const a = clean(original);
  const b = clean(edited);
  if (!a || !b || a === b) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const from = a.slice(start, endA).trim();
  const to = b.slice(start, endB).trim();
  if (!from || !to || from.length > 8 || to.length > 12 || from === to) return null;
  return { from, to };
}

/** 把一条新记录合并进用户词表：同 from 覆盖，最新的排在最前。 */
export function mergeEntry(entries: readonly LexiconEntry[], entry: LexiconEntry): LexiconEntry[] {
  const next = sanitizeEntries([entry, ...entries.filter((item) => item.from.toLowerCase() !== entry.from.toLowerCase())]);
  return next;
}
