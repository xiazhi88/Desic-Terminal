import type { TraderHandbook, TraderHandbookSetup } from "./ai";

/** 交易手册的上限（与后端 `validate_handbook_for_publish` 一致；后端是最终校验）。 */
export const HANDBOOK_LIMITS = {
  setups: 20,
  rules: 12,
  setupText: 400,
  name: 40,
  rule: 200,
  policy: 400,
  rendered: 12_000
} as const;

export const HANDBOOK_REGIMES = ["up", "down", "mixed"] as const;

/** 形态 / 规则 id：小写字母、数字、下划线，1–40 个字符（与后端 `valid_identifier` 一致）。 */
export function validHandbookId(value: string) {
  return /^[a-z0-9_]{1,40}$/.test(value);
}

export function uniqueHandbookId(prefix: string, taken: Iterable<string>) {
  const used = new Set(taken);
  for (let index = 1; index < 1_000; index += 1) {
    const candidate = `${prefix}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix}_${Date.now().toString(36)}`;
}

/** 形态 id 建议：英文名转成小写下划线；中文等其它名称用 `setup_N`。 */
export function suggestSetupId(name: string, taken: Iterable<string>) {
  const used = new Set(taken);
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  if (/^[a-z]/.test(slug)) return used.has(slug) ? uniqueHandbookId(slug, used) : slug;
  return uniqueHandbookId("setup", used);
}

/** 用户新写的形态：默认「观察中」，先用影子结算看效果。 */
export function blankSetup(id: string): TraderHandbookSetup {
  return {
    id,
    name: "",
    regimes: ["up", "down"],
    direction: "with_trend",
    entry: "",
    stop: "",
    target: "",
    invalidation: "",
    stopAtrMin: 1,
    status: "observing"
  };
}

export function setupIsLive(setup: Pick<TraderHandbookSetup, "status">) {
  return setup.status === "live";
}

/** 提示词里手册正文的大致长度（只用来提示；准确的上限由后端按真实渲染结果校验）。 */
export function estimateHandbookChars(handbook: TraderHandbook) {
  const setupChars = handbook.setups.reduce(
    (sum, setup) => sum + 90 + [setup.name, setup.entry, setup.stop, setup.target, setup.invalidation, setup.sizeNote ?? ""].join("").length,
    0
  );
  const ruleChars = [...handbook.noTradeRules, ...handbook.managementRules].reduce((sum, rule) => sum + 3 + rule.text.length, 0);
  const pausedChars = handbook.paused.reduce((sum, entry) => sum + 20 + entry.setupId.length + entry.reason.length, 0);
  return 420 + handbook.directionPolicy.length + setupChars + ruleChars + pausedChars;
}

export type HandbookTextLabels = {
  directionPolicy: string;
  setup: string;
  regimes: string;
  direction: string;
  entry: string;
  stop: string;
  target: string;
  invalidation: string;
  limits: string;
  minNetRr: string;
  stopAtrMin: string;
  stopAtrMax: string;
  sizeNote: string;
  noTrade: string;
  management: string;
  paused: string;
  all: string;
  status: (status: string) => string;
  directionValue: (direction: string) => string;
  regime: (regime: string) => string;
  side: (side: string) => string;
};

/** 手册转成逐行文本（版次对比用）：每个字段一行，顺序固定，改一处只影响一两行。 */
export function handbookToText(handbook: TraderHandbook, labels: HandbookTextLabels) {
  const lines = [`${labels.directionPolicy}: ${handbook.directionPolicy}`];
  for (const setup of handbook.setups) {
    lines.push("", `## ${labels.setup} ${setup.id} · ${setup.name} [${labels.status(setup.status)}]`);
    lines.push(`${labels.regimes}: ${setup.regimes.map(labels.regime).join(" / ")}`);
    lines.push(`${labels.direction}: ${labels.directionValue(setup.direction)}`);
    lines.push(`${labels.entry}: ${setup.entry}`);
    lines.push(`${labels.stop}: ${setup.stop}`);
    lines.push(`${labels.target}: ${setup.target}`);
    lines.push(`${labels.invalidation}: ${setup.invalidation}`);
    const limits = [
      setup.minNetRr !== undefined ? `${labels.minNetRr} ${setup.minNetRr}` : null,
      setup.stopAtrMin !== undefined ? `${labels.stopAtrMin} ${setup.stopAtrMin}×ATR(1h)` : null,
      setup.stopAtrMax !== undefined ? `${labels.stopAtrMax} ${setup.stopAtrMax}×ATR(1h)` : null,
      setup.sizeNote ? `${labels.sizeNote} ${setup.sizeNote}` : null
    ].filter(Boolean);
    if (limits.length > 0) lines.push(`${labels.limits}: ${limits.join("; ")}`);
  }
  lines.push("", `## ${labels.noTrade}`, ...handbook.noTradeRules.map((rule) => `- ${rule.text}`));
  lines.push("", `## ${labels.management}`, ...handbook.managementRules.map((rule) => `- ${rule.text}`));
  if (handbook.paused.length > 0) {
    lines.push("", `## ${labels.paused}`);
    for (const entry of handbook.paused) {
      const scope = [entry.regime ? labels.regime(entry.regime) : null, entry.side ? labels.side(entry.side) : null].filter(Boolean).join(" · ") || labels.all;
      lines.push(`- ${entry.setupId} (${scope}): ${entry.reason}`);
    }
  }
  return lines.join("\n");
}

/** 两版手册之间改了哪些形态（版次列表、手册建议的摘要用）。 */
export type HandbookChangeSummary = {
  added: string[];
  removed: string[];
  changed: string[];
  wentLive: string[];
  wentObserving: string[];
  rulesChanged: boolean;
  policyChanged: boolean;
};

export function summarizeHandbookChanges(before: TraderHandbook, after: TraderHandbook): HandbookChangeSummary {
  const previous = new Map(before.setups.map((setup) => [setup.id, setup]));
  const next = new Map(after.setups.map((setup) => [setup.id, setup]));
  const comparable = (setup: TraderHandbookSetup) => JSON.stringify({ ...setup, status: undefined });
  const summary: HandbookChangeSummary = { added: [], removed: [], changed: [], wentLive: [], wentObserving: [], rulesChanged: false, policyChanged: false };
  for (const setup of after.setups) {
    const old = previous.get(setup.id);
    if (!old) {
      summary.added.push(setup.id);
      continue;
    }
    if (comparable(old) !== comparable(setup)) summary.changed.push(setup.id);
    if (setupIsLive(old) !== setupIsLive(setup)) (setupIsLive(setup) ? summary.wentLive : summary.wentObserving).push(setup.id);
  }
  for (const setup of before.setups) if (!next.has(setup.id)) summary.removed.push(setup.id);
  summary.rulesChanged = JSON.stringify([before.noTradeRules, before.managementRules]) !== JSON.stringify([after.noTradeRules, after.managementRules]);
  summary.policyChanged = before.directionPolicy !== after.directionPolicy;
  return summary;
}

/** 编辑器里的副本与服务器版本是否不同（只比内容，忽略键顺序之外的格式差异）。 */
export function handbooksEqual(left: TraderHandbook, right: TraderHandbook) {
  return JSON.stringify(normalizeForCompare(left)) === JSON.stringify(normalizeForCompare(right));
}

function normalizeForCompare(handbook: TraderHandbook) {
  return {
    directionPolicy: handbook.directionPolicy,
    setups: handbook.setups.map((setup) => ({
      id: setup.id,
      name: setup.name,
      regimes: [...setup.regimes],
      direction: setup.direction,
      entry: setup.entry,
      stop: setup.stop,
      target: setup.target,
      invalidation: setup.invalidation,
      minNetRr: setup.minNetRr ?? null,
      stopAtrMin: setup.stopAtrMin ?? null,
      stopAtrMax: setup.stopAtrMax ?? null,
      sizeNote: setup.sizeNote || null,
      status: setup.status
    })),
    noTradeRules: handbook.noTradeRules.map((rule) => ({ id: rule.id, text: rule.text })),
    managementRules: handbook.managementRules.map((rule) => ({ id: rule.id, text: rule.text })),
    paused: handbook.paused.map((entry) => ({ setupId: entry.setupId, regime: entry.regime ?? null, side: entry.side ?? null, reason: entry.reason, pausedAt: entry.pausedAt }))
  };
}

/** 单个形态转成逐行文本（手册建议的前后对比用）。 */
export function setupToText(setup: Partial<TraderHandbookSetup>, labels: HandbookTextLabels) {
  const handbook: TraderHandbook = {
    directionPolicy: "",
    setups: [{
      id: setup.id ?? "",
      name: setup.name ?? "",
      regimes: setup.regimes ?? [],
      direction: setup.direction ?? "with_trend",
      entry: setup.entry ?? "",
      stop: setup.stop ?? "",
      target: setup.target ?? "",
      invalidation: setup.invalidation ?? "",
      minNetRr: setup.minNetRr,
      stopAtrMin: setup.stopAtrMin,
      stopAtrMax: setup.stopAtrMax,
      sizeNote: setup.sizeNote,
      status: setup.status ?? "live"
    }],
    noTradeRules: [],
    managementRules: [],
    paused: []
  };
  // 只取形态那一段（去掉方向纪律行与空的清单标题）。
  const lines = handbookToText(handbook, labels).split("\n");
  const start = lines.findIndex((line) => line.startsWith("## "));
  const end = lines.findIndex((line, index) => index > start && line === "");
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}
