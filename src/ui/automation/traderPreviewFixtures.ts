import type {
  TraderDecisionRow,
  TraderEntryOrder,
  TraderInstructionRow,
  TraderHandbook,
  TraderHandbookDetail,
  TraderHandbookLibraryEntry,
  TraderHandbookRevision,
  TraderScorecardData
} from "../../lib/ai";
import type { AiOptimizationSuggestion } from "../../types";
import type { TraderHandbookApi, TraderInstructionApi } from "./traderApi";

/**
 * 预览页（`/automation-preview`）用的交易员数据：数字和文字都是示例，结构与桌面命令的返回一致。
 * 浏览器里没有桌面命令，手册的读写由 `createPreviewHandbookApi` 在内存里模拟。
 */

const T0 = Date.UTC(2026, 9, 5, 2, 0);
const DAY_MS = 86_400_000;

export const PREVIEW_TRADER_PROFILES = [
  { id: "profile-trader", name: "BTC 交易员", handbookId: "default", symbols: ["BTC-USDT-SWAP", "SOL-USDT-SWAP"] },
  { id: "profile-trader-eth", name: "ETH 交易员", handbookId: "handbook-breakout", symbols: ["ETH-USDT-SWAP"] }
];

export const PREVIEW_DEFAULT_HANDBOOK: TraderHandbook = {
  directionPolicy: "日线上升只做多、日线下降只做空；日线不明时只用 breakout_retest 或 range_edge。",
  setups: [
    { id: "trend_pullback", name: "顺势回踩", regimes: ["up", "down"], direction: "with_trend", entry: "回撤到 1h / 4h 结构位或 EMA20 附近并出现拒绝信号后入场。", stop: "结构位之外，至少 1×ATR(1h)。", target: "前高 / 前低，且至少 2R。", invalidation: "收盘有效跌破结构位。", stopAtrMin: 1, status: "live" },
    { id: "breakout_retest", name: "突破回踩", regimes: ["up", "down", "mixed"], direction: "with_trend", entry: "放量突破区间后回踩突破位不破再入场。", stop: "突破位之下 / 之上。", target: "区间高度的等幅。", invalidation: "回到区间内收盘。", stopAtrMin: 1, status: "live" },
    { id: "range_edge", name: "区间边缘", regimes: ["mixed"], direction: "both", entry: "区间上沿拒绝做空、下沿拒绝做多。", stop: "区间外，至少 1×ATR(1h)。", target: "中轴，再看对侧。", invalidation: "收盘突破区间边缘。", stopAtrMin: 1, status: "live" },
    { id: "funding_fade", name: "资金费率背离", regimes: ["up", "mixed"], direction: "both", entry: "资金费率连续 3 期 > 0.05% 且价格不再创新高时，等 15m 跌破前低再做空。", stop: "最近高点之上。", target: "回到费率转正前的价位。", invalidation: "价格放量创新高。", minNetRr: 1.5, stopAtrMin: 1, sizeNote: "只用正常仓位的一半", status: "observing" }
  ],
  noTradeRules: [
    { id: "no_data", text: "结构、ATR 或行情阶段有任何一项拿不到（简报写「不可用」时先用工具补读，补读后仍然没有）。" },
    { id: "mid_range", text: "价格处于区间中部（40%–60%）。" }
  ],
  managementRules: [{ id: "breakeven", text: "浮盈达到 1R 后，可以把止损移到保本。" }],
  paused: [{ setupId: "range_edge", regime: "up", side: "short", reason: "在成绩单页手动暂停", pausedAt: T0 }]
};

const PREVIEW_BREAKOUT_HANDBOOK: TraderHandbook = {
  directionPolicy: "只做顺日线趋势的突破。",
  setups: [
    { ...PREVIEW_DEFAULT_HANDBOOK.setups[1] },
    { id: "squeeze_break", name: "收敛突破", regimes: ["up", "down"], direction: "with_trend", entry: "4h 布林带宽处于 30 天最低 10% 后，放量收出突破 K 线再入场。", stop: "突破 K 线的另一端。", target: "至少 2.5R。", invalidation: "两根 K 线内回到带内。", status: "observing" }
  ],
  noTradeRules: [{ id: "news_window", text: "重要数据公布前后 30 分钟。" }],
  managementRules: [{ id: "trail", text: "到 2R 后用 1h 结构位移动止损。" }],
  paused: []
};

export const PREVIEW_TRADER_SCORECARD: TraderScorecardData = (() => {
  const decision = (index: number, patch: Partial<TraderDecisionRow>): TraderDecisionRow => ({
    id: `decision-preview-${index}`,
    runId: `run-preview-${index}`,
    instId: "BTC-USDT-SWAP",
    createdAt: T0 - index * 3_600_000,
    setupId: "trend_pullback",
    side: "long",
    action: "limit_order",
    entry: 84_750,
    stop: 84_450,
    target: 85_350,
    probability: 0.55,
    validUntil: null,
    reason: "日线上升，回踩 1h EMA20 出现长下影",
    regimeDaily: "up",
    regime4h: "up",
    againstDirection: false,
    regimeMismatch: false,
    shadowStatus: "resolved",
    shadowNote: null,
    shadowR: 1.9,
    exitKind: "target",
    realR: null,
    opportunityId: null,
    handbookVersion: 3,
    handbookId: "default",
    setupStatus: "live",
    ...patch
  });
  return {
    profileId: null,
    fromMs: T0 - 30 * DAY_MS,
    pending: 3,
    scorecard: {
      decisions: 48,
      resolved: 41,
      executed: 9,
      groups: [
        { handbookId: "default", setupId: "trend_pullback", regime: "up", side: "long", n: 22, wins: 10, avgR: 0.42, shrunkAvgR: 0.29, totalR: 9.2, realN: 6, realAvgR: 0.31, observingN: 0, flagged: false },
        { handbookId: "default", setupId: "range_edge", regime: "up", side: "short", n: 16, wins: 3, avgR: -0.52, shrunkAvgR: -0.32, totalR: -8.3, realN: 2, realAvgR: -1.0, observingN: 0, flagged: true },
        { handbookId: "default", setupId: "funding_fade", regime: "up", side: "short", n: 3, wins: 2, avgR: 0.8, shrunkAvgR: 0.18, totalR: 2.4, realN: 0, realAvgR: null, observingN: 3, flagged: false }
      ],
      calibration: [
        { lo: 0.45, hi: 0.6, n: 18, predicted: 0.54, realized: 0.44 },
        { lo: 0.6, hi: 0.75, n: 12, predicted: 0.66, realized: 0.33 }
      ],
      waits: { n: 19, missedR: 6.4, avoidedR: 9.1 },
      compliance: { againstN: 16, againstAvgR: -0.52, alignedN: 25, alignedAvgR: 0.47, regimeMismatchN: 4 },
      versions: [{ version: 3, n: 41, avgR: 0.04 }]
    },
    recent: [
      decision(0, {}),
      decision(1, { setupId: "range_edge", side: "short", entry: 85_390, stop: 85_500, target: 85_040, againstDirection: true, shadowR: -1.05, exitKind: "stop", realR: -1.05, opportunityId: "opp-preview", correction: { category: "wrong_direction", text: "日线上升时别在区间上沿逆势做空", updatedAt: T0 } }),
      decision(2, { setupId: "funding_fade", side: "short", action: "limit_order", entry: 85_600, stop: 85_900, target: 84_900, probability: 0.45, shadowR: 2.2, exitKind: "target", setupStatus: "observing", reason: "费率连续 3 期 0.06%，15m 跌破前低（观察中，只记录）" }),
      decision(3, { shadowStatus: "pending", shadowR: null, exitKind: null })
    ],
    handbook: { id: "default", name: null, version: 3, revision: 3, content: PREVIEW_DEFAULT_HANDBOOK, fallback: null }
  };
})();

type PreviewBook = {
  id: string;
  name: string | null;
  origin: string;
  createdAt: number;
  archivedAt: number | null;
  revisions: TraderHandbookRevision[];
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 内存里的手册库：发布、回退、新建、重命名、归档都在本页生效，刷新页面后还原。 */
export function createPreviewHandbookApi(): TraderHandbookApi {
  let nextVersion = 10;
  const revision = (version: number, rev: number, source: string, note: string, content: TraderHandbook, createdAt: number): TraderHandbookRevision => ({
    version,
    revision: rev,
    source,
    note,
    createdAt,
    suggestionId: null,
    content: clone(content)
  });
  const pausedFree = { ...PREVIEW_DEFAULT_HANDBOOK, paused: [] };
  const books = new Map<string, PreviewBook>([
    ["default", {
      id: "default",
      name: null,
      origin: "builtin",
      createdAt: T0 - 40 * DAY_MS,
      archivedAt: null,
      revisions: [
        revision(9, 3, "pause", "手动暂停 range_edge", PREVIEW_DEFAULT_HANDBOOK, T0 - DAY_MS),
        revision(5, 2, "edit", "新增形态 funding_fade（观察中）", pausedFree, T0 - 6 * DAY_MS),
        revision(1, 1, "builtin", "内置模板", { ...pausedFree, setups: pausedFree.setups.slice(0, 3) }, T0 - 40 * DAY_MS)
      ]
    }],
    ["handbook-breakout", {
      id: "handbook-breakout",
      name: "我的突破打法",
      origin: "copy",
      createdAt: T0 - 12 * DAY_MS,
      archivedAt: null,
      revisions: [revision(6, 1, "copy", "复制自「我的手册」第 2 版", PREVIEW_BREAKOUT_HANDBOOK, T0 - 12 * DAY_MS)]
    }]
  ]);
  const scores: Record<string, TraderHandbookLibraryEntry["score90d"]> = {
    default: { resolved: 41, avgR: 0.12, shrunkAvgR: 0.096, totalR: 4.9 },
    "handbook-breakout": { resolved: 6, avgR: 0.35, shrunkAvgR: 0.131, totalR: 2.1 }
  };
  const cancelled = new Set<string>();
  const users = (id: string) => PREVIEW_TRADER_PROFILES.filter((profile) => profile.handbookId === id).map(({ id: profileId, name }) => ({ id: profileId, name }));
  const latest = (book: PreviewBook) => book.revisions[0];
  const wait = () => new Promise((resolve) => window.setTimeout(resolve, 120));
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const find = (id: string) => books.get(id) ?? fail(`交易手册 ${id} 不存在`);
  const detail = (book: PreviewBook): TraderHandbookDetail => {
    const current = latest(book);
    return {
      id: book.id,
      name: book.name,
      version: current.version,
      revision: current.revision,
      content: clone(current.content as TraderHandbook),
      fallback: null,
      origin: book.origin,
      archivedAt: book.archivedAt,
      usedBy: users(book.id)
    };
  };
  const push = (book: PreviewBook, content: TraderHandbook, source: string, note: string) => {
    if (book.archivedAt) fail("这本交易手册已归档，不能修改");
    nextVersion += 1;
    const next = revision(nextVersion, latest(book).revision + 1, source, note, content, Date.now());
    book.revisions.unshift(next);
    return { handbookId: book.id, version: next.version, revision: next.revision, content: clone(content) };
  };
  return {
    list: async (includeArchived) => {
      await wait();
      return [...books.values()]
        .filter((book) => includeArchived || !book.archivedAt)
        .map((book) => {
          const current = latest(book);
          const content = current.content as TraderHandbook;
          return {
            id: book.id,
            name: book.name,
            origin: book.origin,
            createdAt: book.createdAt,
            updatedAt: current.createdAt,
            archivedAt: book.archivedAt,
            version: current.version,
            revision: current.revision,
            setupCount: content.setups.length,
            observingCount: content.setups.filter((setup) => setup.status !== "live").length,
            pausedCount: content.paused.length,
            usedBy: users(book.id),
            score90d: scores[book.id] ?? { resolved: 0, avgR: null, shrunkAvgR: null, totalR: 0 }
          };
        });
    },
    detail: async (id) => {
      await wait();
      return detail(find(id));
    },
    revisions: async (id) => {
      await wait();
      return clone(find(id).revisions);
    },
    create: async (name, sourceId) => {
      await wait();
      const source = sourceId ? find(sourceId) : find("default");
      const id = `handbook-preview-${books.size + 1}`;
      const book: PreviewBook = { id, name: name.trim(), origin: sourceId ? "copy" : "template", createdAt: Date.now(), archivedAt: null, revisions: [] };
      nextVersion += 1;
      book.revisions.push(revision(nextVersion, 1, book.origin, sourceId ? "复制" : "从内置模板新建", (sourceId ? latest(source) : source.revisions[source.revisions.length - 1]).content as TraderHandbook, Date.now()));
      books.set(id, book);
      return detail(book);
    },
    rename: async (id, name) => {
      await wait();
      const book = find(id);
      book.name = name.trim();
      return detail(book);
    },
    archive: async (id, archived) => {
      await wait();
      const book = find(id);
      if (archived && id === "default") fail("默认手册不能归档");
      if (archived && users(id).length > 0) fail("还有交易员 Profile 在用这本手册，先给它们换一本");
      book.archivedAt = archived ? Date.now() : null;
      return detail(book);
    },
    publish: async (id, content, baseRevision) => {
      await wait();
      const book = find(id);
      if (latest(book).revision !== baseRevision) fail(`handbook_conflict：这本手册已经更新到第 ${latest(book).revision} 版（你改的是第 ${baseRevision} 版），请重新加载后再保存`);
      const ids = content.setups.map((setup) => setup.id);
      return push(book, { ...content, paused: content.paused.filter((entry) => ids.includes(entry.setupId)) }, "edit", "编辑手册");
    },
    rollback: async (id, toRevision, baseRevision) => {
      await wait();
      const book = find(id);
      const current = latest(book);
      if (current.revision !== baseRevision) fail(`handbook_conflict：这本手册已经更新到第 ${current.revision} 版`);
      const target = toRevision === null ? book.revisions[book.revisions.length - 1] : book.revisions.find((item) => item.revision === toRevision) ?? fail(`这本手册没有第 ${toRevision} 版`);
      const currentContent = current.content as TraderHandbook;
      const merged = clone(target.content as TraderHandbook);
      for (const setup of merged.setups) {
        const now = currentContent.setups.find((item) => item.id === setup.id);
        setup.status = setup.status === "live" && now?.status === "live" ? "live" : "observing";
      }
      merged.paused = currentContent.paused.filter((entry) => merged.setups.some((setup) => setup.id === entry.setupId));
      return push(book, merged, toRevision === null ? "reset" : "rollback", toRevision === null ? "恢复成内置模板" : `回退到第 ${toRevision} 版`);
    },
    // 假起草器：每 150ms 报一次字数，约 1.5 秒后给出草稿；取消后不再产出。
    draftSetup: async ({ requestId, handbookId, onDelta }) => {
      cancelled.delete(requestId);
      for (let chars = 60; chars <= 420; chars += 60) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        if (cancelled.has(requestId)) throw new Error("草稿生成已取消");
        onDelta?.(chars);
      }
      const taken = latest(find(handbookId ?? "default")).content?.setups.map((setup) => setup.id) ?? [];
      return {
        setup: {
          id: taken.includes("oi_squeeze") ? "oi_squeeze_1" : "oi_squeeze",
          name: "持仓量挤压",
          regimes: ["up", "down"],
          direction: "with_trend",
          entry: "1h 持仓量 4 小时内上升超过 8% 且价格横盘时，等价格顺日线方向突破横盘区间的 15m 收盘再入场。",
          stop: "横盘区间的另一侧。",
          target: "至少 2R，或前高 / 前低。",
          invalidation: "突破后 2 根 15m K 线内回到区间。",
          status: "observing"
        },
        notes: ["没有说明横盘要多久才算：先写成「4 小时内」，请确认", "没有说明是否在资金费率极端时也做"],
        warnings: []
      };
    },
    cancelDraft: async (requestId) => {
      cancelled.add(requestId);
    },
    models: async () => ({ models: [{ id: "preview-model", name: "预览模型" }, { id: "preview-model-b", name: "预览模型 B" }], activeModelId: "preview-model" }),
    exportHandbook: async (id) => {
      await wait();
      return `~/Downloads/${find(id).name ?? "我的手册"}.handbook.json`;
    },
    // 假导入：拿「我的突破打法」当文件内容，所有形态设为观察中。
    importHandbook: async () => {
      await wait();
      const content = clone(PREVIEW_BREAKOUT_HANDBOOK);
      content.setups.forEach((setup) => { setup.status = "observing"; });
      const id = `handbook-preview-${books.size + 1}`;
      nextVersion += 1;
      const book: PreviewBook = { id, name: "朋友的突破打法", origin: "import", createdAt: Date.now(), archivedAt: null, revisions: [revision(nextVersion, 1, "import", "从文件导入：friend.handbook.json", content, Date.now())] };
      books.set(id, book);
      return { ...detail(book), importWarnings: ["1 个形态已设为「观察中」：先看影子结果，再决定要不要启用"] };
    }
  };
}

/** Profile 配置窗口预览用的静态手册库（与 `createPreviewHandbookApi` 的初始内容一致）。 */
export const PREVIEW_HANDBOOK_DETAILS: Record<string, TraderHandbookDetail> = {
  default: { id: "default", name: null, version: 9, revision: 3, content: PREVIEW_DEFAULT_HANDBOOK, fallback: null, origin: "builtin", archivedAt: null, usedBy: [{ id: "profile-trader", name: "BTC 交易员" }] },
  "handbook-breakout": { id: "handbook-breakout", name: "我的突破打法", version: 6, revision: 1, content: PREVIEW_BREAKOUT_HANDBOOK, fallback: null, origin: "copy", archivedAt: null, usedBy: [{ id: "profile-trader-eth", name: "ETH 交易员" }] }
};

export const PREVIEW_HANDBOOK_LIBRARY: TraderHandbookLibraryEntry[] = Object.values(PREVIEW_HANDBOOK_DETAILS).map((detail) => ({
  id: detail.id,
  name: detail.name,
  origin: detail.origin,
  createdAt: T0 - 30 * DAY_MS,
  updatedAt: T0 - DAY_MS,
  archivedAt: null,
  version: detail.version,
  revision: detail.revision,
  setupCount: detail.content.setups.length,
  observingCount: detail.content.setups.filter((setup) => setup.status !== "live").length,
  pausedCount: detail.content.paused.length,
  usedBy: detail.usedBy,
  score90d: detail.id === "default" ? { resolved: 41, avgR: 0.12, shrunkAvgR: 0.096, totalR: 4.9 } : { resolved: 6, avgR: 0.35, shrunkAvgR: 0.131, totalR: 2.1 }
}));

/** 内存里的临时指令（预览页用）：一条生效中的「只做多」、一条「说明」，外加一条已结束的。 */
export function createPreviewInstructionApi(): TraderInstructionApi {
  const now = Date.now();
  let items: TraderInstructionRow[] = [
    { id: "instruction-preview-1", profileId: "profile-trader", instId: "BTC-USDT-SWAP", kind: "long_only", text: "这周只做多 BTC", createdAt: now - 2 * 3_600_000, expiresAt: now + 3 * DAY_MS, cancelledAt: null, profileName: "BTC 交易员", status: "active" },
    { id: "instruction-preview-2", profileId: null, instId: null, kind: "note", text: "周五非农前别加仓", createdAt: now - 3_600_000, expiresAt: now + DAY_MS, cancelledAt: null, profileName: null, status: "active" },
    { id: "instruction-preview-3", profileId: null, instId: null, kind: "no_entry", text: "CPI 前后一小时", createdAt: now - 3 * DAY_MS, expiresAt: now - 2 * DAY_MS, cancelledAt: null, profileName: null, status: "expired" }
  ];
  const orders: TraderEntryOrder[] = [
    { opportunityId: "opp-preview-short", profileId: "profile-trader", instId: "BTC-USDT-SWAP", ordId: "3981000000000000001", side: "sell", px: 85_400, sz: 0.01, placedAt: now - 3_600_000, validUntil: now + 20 * 3_600_000 }
  ];
  const wait = () => new Promise((resolve) => window.setTimeout(resolve, 120));
  return {
    list: async (includeHistory) => {
      await wait();
      return items.filter((item) => includeHistory || item.status === "active");
    },
    scopeOrders: async (profileId, instId, kind) => {
      await wait();
      const sides = kind === "no_entry" ? ["buy", "sell"] : kind === "long_only" ? ["sell"] : kind === "short_only" ? ["buy"] : [];
      return orders.filter((order) => (!profileId || order.profileId === profileId) && (!instId || order.instId === instId) && sides.includes(order.side));
    },
    create: async (request) => {
      await wait();
      const id = `instruction-preview-${items.length + 1}`;
      items = [{ id, profileId: request.profileId, instId: request.instId, kind: request.kind, text: request.text, createdAt: Date.now(), expiresAt: request.expiresAt, cancelledAt: null, profileName: PREVIEW_TRADER_PROFILES.find((profile) => profile.id === request.profileId)?.name ?? null, status: "active" }, ...items];
      return { instruction: { id }, voidedOpportunities: request.kind === "note" ? 0 : 1, cancelledOrders: request.cancelOrdIds.map((ordId) => ({ ordId, instId: "BTC-USDT-SWAP", ok: true, error: null })) };
    },
    cancel: async (id) => {
      await wait();
      items = items.map((item) => (item.id === id ? { ...item, status: "cancelled", cancelledAt: Date.now() } : item));
    }
  };
}

/** Profile 配置窗口预览用：生效中的临时指令。 */
export const PREVIEW_INSTRUCTIONS: TraderInstructionRow[] = [
  { id: "instruction-preview-1", profileId: "profile-trader", instId: "BTC-USDT-SWAP", kind: "long_only", text: "这周只做多 BTC", createdAt: T0 - 2 * 3_600_000, expiresAt: T0 + 3 * DAY_MS, cancelledAt: null, profileName: "BTC 交易员", status: "active" },
  { id: "instruction-preview-2", profileId: null, instId: null, kind: "note", text: "周五非农前别加仓", createdAt: T0 - 3_600_000, expiresAt: T0 + DAY_MS, cancelledAt: null, profileName: null, status: "active" }
];

/** 优化建议预览：由纠正生成、已经起草好的交易手册建议。 */
export const PREVIEW_HANDBOOK_SUGGESTION: AiOptimizationSuggestion = (() => {
  const baseline = PREVIEW_DEFAULT_HANDBOOK.setups.find((setup) => setup.id === "range_edge")!;
  return {
    id: "suggestion-preview-handbook",
    reviewId: null,
    title: "交易手册建议：「区间边缘」近 30 天被你纠正了 3 次",
    problem: "你对形态 range_edge（区间边缘）的 3 条纠正：方向错 1、位置不好 2。可以让 AI 按这些纠正起草修改，看过前后差异再决定是否采用；采用后会发布手册的新版次，随时可以回退。",
    evidence: [
      "- 10-02 21:30 BTC-USDT-SWAP 做空 limit_order｜方向错：日线已经转上升了，还在上沿做空（影子结果 -1.05R）",
      "- 10-03 09:15 BTC-USDT-SWAP 做空 limit_order｜位置不好：只碰了一下上沿就挂单，没等拒绝（影子结果 -1.00R）",
      "- 10-04 14:00 ETH-USDT-SWAP 做多 limit_order｜位置不好：下沿没有拒绝信号就做多（影子结果 +0.40R）"
    ],
    sampleSize: 3,
    currentSkillId: null,
    currentSkillVersion: null,
    proposedChanges: "入场要求先出现 1h 收盘拒绝；日线阶段离开「不明」时视为失效。",
    baselineSkill: null,
    proposedSkill: null,
    benefits: "如果纠正是对的，预期会减少在趋势启动初期逆势挂单、以及刚碰边缘就成交被打止损的情况。",
    risks: "等收盘拒绝会错过一部分快速反转；10-04 那笔做多的影子结果是正的，「必须等拒绝」可能让这类单子变少。",
    status: "pending_review",
    createdAt: T0 - 3_600_000,
    updatedAt: T0 - 1_800_000,
    kind: "handbook",
    handbook: {
      handbookId: "default",
      handbookName: null,
      handbookRevision: 3,
      setupId: "range_edge",
      baselineSetup: baseline,
      proposedSetup: {
        ...baseline,
        entry: "日线不明、价格在区间上沿（或下沿）出现 1h 收盘拒绝（长影线回到区间内）后再入场：上沿做空、下沿做多；只碰到边缘不算。",
        invalidation: "收盘突破区间边缘，或日线阶段变成上升 / 下降。"
      },
      draftError: null,
      usedBy: [{ id: "profile-trader", name: "BTC 交易员" }]
    }
  };
})();
