/*
 * 值守心电图预览夹具（/automation-preview?view=pulse）。
 *
 * 照搬原型 viz/prototypes/watch-pulse.html 的确定性生成器（固定种子）：4 个 Profile、7 天运行，
 * 形状与 AiAutomationRun / AiRunTriage / AiRunExpert 一致。"现在"从固定锚点起按真实时间推进。
 * 仅供视觉回归与 smoke 使用，所有内容均为合成数据。
 */
import type { AiAutomationRun, AiAutomationRunDetail, AiRunExpert, AiUsageSummary } from "../../types";
import { DAY, HOUR, MIN, fHM, type WatchPulseProfile } from "./watchPulseModel";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FixtureProfile = WatchPulseProfile & {
  enabledAgentIds: string[];
  feishuEnabled: boolean;
  minWakeIntervalSeconds: number;
  symbols: string[];
  triage: { mode: "off" | "shadow" | "enforce"; maxSkips: number; maxSilenceMinutes: number; skipSampleRate: number };
};

export type WatchPulseFixture = {
  anchor: number;
  now: () => number;
  profiles: FixtureProfile[];
  runs: AiAutomationRun[];
  details: Map<string, AiAutomationRunDetail>;
};

const PROFILES: FixtureProfile[] = [
  {
    id: "prof-btc-watch", name: "BTC 主力值守", environment: "demo", symbols: ["BTC-USDT-SWAP"], dailyReviewEnabled: false,
    scanIntervalMinutes: 15, minWakeIntervalSeconds: 300, feishuEnabled: true, enabledAgentIds: ["market-structure", "contrarian"],
    triage: { mode: "enforce", maxSkips: 12, maxSilenceMinutes: 120, skipSampleRate: 0.03 }
  },
  {
    id: "prof-eth-sol-sentinel", name: "ETH / SOL 事件哨兵", environment: "demo", symbols: ["ETH-USDT-SWAP", "SOL-USDT-SWAP"], dailyReviewEnabled: false,
    scanIntervalMinutes: 240, minWakeIntervalSeconds: 300, feishuEnabled: true, enabledAgentIds: ["intelligence-flow", "market-structure", "contrarian"],
    triage: { mode: "enforce", maxSkips: 6, maxSilenceMinutes: 480, skipSampleRate: 0.05 }
  },
  {
    id: "prof-daily-review", name: "每日市场复盘", environment: "demo", symbols: ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"], dailyReviewEnabled: true,
    scanIntervalMinutes: 1440, minWakeIntervalSeconds: 3600, feishuEnabled: true, enabledAgentIds: ["market-structure", "intelligence-flow", "contrarian"],
    triage: { mode: "off", maxSkips: 0, maxSilenceMinutes: 0, skipSampleRate: 0 }
  },
  {
    id: "prof-alt-rotation", name: "山寨轮动", environment: "live", symbols: ["DOGE-USDT-SWAP", "WIF-USDT-SWAP", "SUI-USDT-SWAP"], dailyReviewEnabled: false,
    scanIntervalMinutes: 60, minWakeIntervalSeconds: 600, feishuEnabled: true, enabledAgentIds: ["contrarian"],
    triage: { mode: "enforce", maxSkips: 5, maxSilenceMinutes: 360, skipSampleRate: 0.04 }
  }
];

const EXPERTS: Record<string, { name: string; role: string; mode: "parallel" | "serial"; scopes: string[] }> = {
  "market-structure": { name: "市场结构", role: "market_structure", mode: "parallel", scopes: ["market", "derivatives"] },
  "intelligence-flow": { name: "情报资金", role: "intelligence_flow", mode: "parallel", scopes: ["intelligence", "market"] },
  contrarian: { name: "对手盘", role: "contrarian", mode: "serial", scopes: ["intelligence", "history"] }
};

const SKIP_REASONS: Record<string, string[]> = {
  "prof-btc-watch": ["价格在观察区间内窄幅波动，未触及任何观察位", "资金费率与持仓量无边际变化", "无持仓、无挂单变化"],
  "prof-eth-sol-sentinel": ["条件命中后价格迅速收回，未形成确认", "资金费率回落至阈值以下", "无相关重要事件"],
  "prof-alt-rotation": ["轮动排名与板块广度无边际变化", "无新的相对强度领先者"]
};
const ESC_REASONS: Record<string, string[]> = {
  "prof-btc-watch": ["价格触及观察位且放量", "盘口深度明显失衡", "距上次深度分析已有显著波动"],
  "prof-eth-sol-sentinel": ["观察位被确认突破", "资金费率越过阈值", "出现重要事件，需要评估影响"],
  "prof-alt-rotation": ["板块广度共振，出现新的领先者", "相对强度排名快速上升"]
};
const BASE: Record<string, [number, number, number]> = {
  BTC: [64880, 1, 0.3], ETH: [2412, 2, 1.7], SOL: [147.6, 2, 2.9], DOGE: [0.1932, 4, 4.1], WIF: [1.846, 3, 5.3], SUI: [3.214, 3, 0.8]
};

type MkOptions = {
  start: number;
  trigger: string;
  verdict?: "skip" | "escalate";
  forcedBy?: string[];
  sampled?: boolean;
  deep: boolean;
  fail?: boolean;
  failTriage?: boolean;
  running?: boolean;
  trade?: boolean;
  nextWakeAt?: number;
  expertIds?: string[];
};

type TriageState = { skipStreak: number; lastDeep: number; posChanged: boolean };

export function createWatchPulseFixture(): WatchPulseFixture {
  // 固定锚点，页面加载后按真实流逝推进 —— 数据确定，但"现在"仍在走
  const ANCHOR = new Date(2026, 8, 28, 14, 36, 20).getTime();
  const T0 = typeof performance !== "undefined" ? performance.now() : 0;
  const now = () => ANCHOR + ((typeof performance !== "undefined" ? performance.now() : 0) - T0);
  const DATA_START = ANCHOR - 7 * DAY;
  const R = rng(0x2609_2801);
  const between = (a: number, b: number) => a + R() * (b - a);
  const irand = (a: number, b: number) => Math.floor(between(a, b + 1));
  const pick = <T,>(items: T[]) => items[Math.floor(R() * items.length)];
  const hex = (n: number) => { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(R() * 16).toString(16); return s; };
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const fPrice = (p: number, d: number) => p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const EVENTS = [-5.62 * DAY, -4.08 * DAY, -2.74 * DAY, -1.37 * DAY, -0.355 * DAY, -11 * MIN].map((o) => ANCHOR + o);
  const volAt = (t: number) => EVENTS.some((e) => t > e - 45 * MIN && t < e + 110 * MIN);
  const priceAt = (sym: string, t: number) => {
    const [b, , k] = BASE[sym];
    const x = t / HOUR;
    return b * (1 + 0.011 * Math.sin(x / 5.3 + k) + 0.005 * Math.sin(x / 1.7 + k * 2) + 0.0022 * Math.sin(x * 2.6 + k * 3));
  };
  const pf = (sym: string, t: number) => fPrice(priceAt(sym, t), BASE[sym][1]);

  const usageOf = (input: number, cacheShare: number, output: number, agents = 1): AiUsageSummary => {
    const cacheRead = Math.round(input * cacheShare);
    const usage = { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: input + output };
    return {
      schemaVersion: 1, provider: "openai-compatible", modelId: "model-main", model: "preview-model", modelName: "Preview Model",
      reported: true, quality: "providerReported", coverage: { inputOutput: true, cacheRead: true, cacheWrite: false, reasoning: false },
      agentCount: agents, reportedAgentCount: agents, unreportedAgentCount: 0, usage, mainUsage: usage
    } as AiUsageSummary;
  };
  const addUsage = (a: AiUsageSummary | null, b: AiUsageSummary | null): AiUsageSummary | null => {
    if (!a) return b;
    if (!b) return a;
    const usage = { ...a.usage };
    for (const key of Object.keys(usage) as (keyof typeof usage)[]) usage[key] = (a.usage[key] ?? 0) + (b.usage[key] ?? 0);
    return { ...a, agentCount: Math.max(a.agentCount, b.agentCount), reportedAgentCount: Math.max(a.agentCount, b.agentCount), usage, mainUsage: a.mainUsage };
  };

  const evidenceFor = (p: FixtureProfile, t: number, deep: boolean) => {
    const at = (s: number) => iso(t + s * 1000);
    const out: { fact: string; source: string; at: string }[] = [];
    if (p.id === "prof-btc-watch") {
      const lvl = [65800, 64200, 65400, 64650][irand(0, 3)];
      if (deep) {
        out.push({ fact: `5m 收盘 ${pf("BTC", t)}，触及观察位 ${fPrice(lvl, 0)}`, source: "market.readCandles", at: at(4) });
        out.push({ fact: `15m 主动卖出占比 ${irand(56, 67)}%`, source: "market.readRecentTrades", at: at(6) });
        out.push({ fact: `±0.5% 盘口卖方深度为买方 ${between(1.4, 2.3).toFixed(1)} 倍`, source: "market.readOrderBook", at: at(7) });
      } else {
        out.push({ fact: `最新价 ${pf("BTC", t)}，距上次深度分析变动 ${between(0.03, 0.31).toFixed(2)}%`, source: "market.readTicker", at: at(3) });
        out.push({ fact: `距最近观察位 ${fPrice(lvl, 0)} 仍有 ${between(0.4, 1.3).toFixed(2)}%`, source: "market.readDecisionContext", at: at(5) });
      }
      out.push(R() < 0.5
        ? { fact: `资金费率 ${between(0.003, 0.011).toFixed(4)}%，与上轮持平`, source: "market.readFundingRate", at: at(8) }
        : { fact: "无持仓，无挂单变化", source: "account.readSnapshot", at: at(9) });
    } else if (p.id === "prof-eth-sol-sentinel") {
      if (deep) {
        out.push({ fact: `ETH 5m 收盘 ${pf("ETH", t)}，确认跌破观察位 ${fPrice(Math.round(priceAt("ETH", t) / 10) * 10 + 10, 0)}`, source: "market.readCandles", at: at(3) });
        out.push({ fact: `SOL 资金费率 ${between(0.031, 0.058).toFixed(3)}%，超过阈值 0.030%`, source: "market.readFundingRate", at: at(5) });
        if (R() < 0.6) out.push({ fact: pick(["美国 CPI 公布，实际值高于预期 0.1pp", "某交易所公告 SOL 质押提取延迟", "ETH ETF 单日净流出扩大至 1.9 亿美元"]), source: "intelligence.news.listEvents", at: at(9) });
      } else {
        out.push({ fact: `ETH ${pf("ETH", t)} 回到观察区间内，未确认突破`, source: "market.readCandles", at: at(3) });
        out.push({ fact: `SOL 资金费率 ${between(0.004, 0.02).toFixed(3)}%，低于阈值`, source: "market.readFundingRate", at: at(6) });
      }
    } else {
      if (deep) {
        out.push({ fact: `DOGE 相对强度排名 ${irand(14, 30)} → ${irand(2, 8)}`, source: "radar.readRankHistory", at: at(4) });
        out.push({ fact: `Meme 板块广度 ${irand(19, 26)}/28 上涨`, source: "radar.readBreadth", at: at(6) });
        out.push({ fact: `WIF 资金费率 ${between(0.02, 0.06).toFixed(3)}%`, source: "market.readFundingRate", at: at(8) });
      } else {
        out.push({ fact: "轮动排名前 5 无变化（DOGE / SUI / WIF 位次不变）", source: "radar.readRanking", at: at(4) });
        out.push({ fact: `Meme 板块广度 ${irand(11, 17)}/28 上涨，无共振`, source: "radar.readBreadth", at: at(6) });
      }
    }
    return out;
  };
  const pickN = (arr: string[], n: number) => { const a = arr.slice(); const o: string[] = []; while (o.length < n && a.length) o.push(a.splice(Math.floor(R() * a.length), 1)[0]); return o; };

  const RUNS: AiAutomationRun[] = [];

  function mkRun(p: FixtureProfile, o: MkOptions): AiAutomationRun {
    const run: AiAutomationRun = {
      id: `run-${hex(8)}`, profileId: p.id, triggerType: o.trigger, status: "completed",
      triage: null, experts: null, summary: null, error: null,
      startedAt: Math.round(o.start), finishedAt: null, nextWakeAt: null,
      actionCounts: { opportunity: 0, wake: 0, trade: 0, notification: 0 }, tokenUsage: null,
      audit: null, recordKind: "ai", singleAgentMode: "standard"
    };
    const triageOn = p.triage.mode !== "off";
    let t = o.start;
    let triageUsage: AiUsageSummary | null = null;
    if (triageOn) {
      t += between(22, 68) * 1000;
      triageUsage = usageOf(irand(4200, 13500), between(0.52, 0.82), irand(260, 900));
      const verdict = o.verdict ?? "skip";
      const deepTriage = verdict === "escalate";
      run.triage = {
        mode: p.triage.mode, verdict, escalate: verdict === "escalate",
        phase: o.failTriage ? "triage" : o.deep ? "deep" : "skipped",
        reasons: pickN(deepTriage ? ESC_REASONS[p.id] : SKIP_REASONS[p.id], irand(1, 2)),
        evidence: evidenceFor(p, o.start, deepTriage || (o.forcedBy ?? []).includes("confirmedBreakOfFlaggedLevel")),
        forcedBy: o.forcedBy ?? [], forced: (o.forcedBy ?? []).length > 0, sampled: Boolean(o.sampled),
        triageTokens: triageUsage.usage.totalTokens, deepTokens: 0,
        triageUsage, deepUsage: null
      };
      if (o.failTriage) {
        run.triage.verdict = undefined;
        run.triage.escalate = undefined;
        run.triage.reasons = [];
        run.triage.evidence = (run.triage.evidence ?? []).slice(0, 1);
        run.status = "failed";
        run.error = "试判超时：account.readPositions 15 秒无响应，本轮未提交试判结论";
        run.finishedAt = Math.round(t + 15000);
        run.tokenUsage = triageUsage;
        run.nextWakeAt = run.finishedAt + p.scanIntervalMinutes * MIN;
        return run;
      }
    }
    if (!o.deep) {
      run.status = "skipped";
      run.finishedAt = Math.round(t + between(2, 6) * 1000);
      run.summary = `试判跳过：${run.triage?.reasons?.[0] ?? ""}`;
      run.actionCounts!.wake = 1; // skip 必须带 nextWakePlan
      run.tokenUsage = triageUsage;
      run.nextWakeAt = o.nextWakeAt ?? run.finishedAt + p.scanIntervalMinutes * MIN;
      return run;
    }
    // ── 深度阶段 ──
    const deepStart = t + between(3, 8) * 1000;
    const ids = o.expertIds ?? (R() < 0.22 && p.id !== "prof-daily-review" ? [] : p.enabledAgentIds.slice());
    const experts: AiRunExpert[] = [];
    const cursor = deepStart + between(8, 22) * 1000;
    let parEnd = cursor;
    let deepUsage = usageOf(irand(60000, p.id === "prof-daily-review" ? 240000 : 150000), between(0.55, 0.85), irand(2500, 9000));
    for (const id of ids) {
      const e = EXPERTS[id];
      let s: number;
      let d: number;
      if (e.mode === "parallel") { s = cursor + between(0, 6) * 1000; d = between(35, p.id === "prof-daily-review" ? 210 : 140) * 1000; parEnd = Math.max(parEnd, s + d); }
      else { s = parEnd + between(3, 12) * 1000; d = between(22, 85) * 1000; parEnd = s + d; }
      const input = irand(40000, 260000);
      const out = irand(1800, 12500);
      experts.push({
        expertId: id, configuredAgentId: id, agentId: `${run.id}-${id}`, name: e.name, role: e.role, mode: e.mode,
        grantedScopes: e.scopes, toolCalls: irand(1, 6), durationMs: Math.round(d),
        startedAt: Math.round(s), endedAt: Math.round(s + d),
        tokenUsage: { inputTokens: input, outputTokens: out, totalTokens: input + out }
      });
      deepUsage = addUsage(deepUsage, usageOf(input, between(0.5, 0.8), out))!;
    }
    deepUsage.agentCount = deepUsage.reportedAgentCount = 1 + experts.length;
    run.experts = experts;
    if (!experts.length) run.audit = { selfAnalysisReason: "本轮证据集中在单一标的行情，主 Agent 自行完成取数与判断。", selfAnalysisUnjustified: false };
    const lastEnd = experts.length ? Math.max(...experts.map((e) => e.endedAt ?? 0)) : deepStart + between(60, 200) * 1000;
    let finish = lastEnd + between(14, 48) * 1000;

    if (run.triage) { run.triage.deepTokens = deepUsage.usage.totalTokens; run.triage.deepUsage = deepUsage; }

    if (o.running) {
      run.status = "running";
      run.finishedAt = null;
      run.nextWakeAt = null;
      const last = experts[experts.length - 1];
      if (last) { last.endedAt = undefined; last.durationMs = undefined; last.tokenUsage = null; last.tokensUnavailable = true; last.toolCalls = 2; }
      if (run.triage) { run.triage.deepTokens = undefined; run.triage.deepUsage = null; }
      run.tokenUsage = triageUsage;
      return run;
    }
    if (o.fail) {
      const last = experts[experts.length - 1];
      finish = last ? (last.startedAt ?? deepStart) + between(20, 50) * 1000 : deepStart + 90000;
      if (last) { last.endedAt = Math.round(finish); last.durationMs = Math.round(finish - (last.startedAt ?? finish)); last.tokenUsage = null; last.tokensUnavailable = true; }
      run.status = "failed";
      run.error = "模型请求失败：HTTP 529 服务过载（已重试 3 次）；本轮未落任何动作";
      run.finishedAt = Math.round(finish + 2000);
      const partial = usageOf(irand(38000, 52000), 0.61, irand(900, 1600));
      if (run.triage) { run.triage.deepTokens = partial.usage.totalTokens; run.triage.deepUsage = partial; }
      run.tokenUsage = addUsage(triageUsage, partial);
      run.nextWakeAt = run.finishedAt + p.scanIntervalMinutes * MIN;
      return run;
    }
    run.finishedAt = Math.round(finish);
    run.tokenUsage = addUsage(triageUsage, deepUsage);
    const ac = run.actionCounts as { opportunity: number; wake: number; trade: number; notification: number };
    ac.wake = irand(1, 3);
    if (o.trade) { ac.trade = 1; ac.opportunity = 1; }
    else if (R() < (p.id === "prof-daily-review" ? 0.45 : 0.17)) ac.opportunity = 1 + (R() < 0.2 ? 1 : 0);
    if (p.feishuEnabled && (ac.opportunity || ac.trade || p.id === "prof-daily-review")) ac.notification = 1 + (ac.trade ? 1 : 0);
    const sym = p.symbols[0].split("-")[0];
    if (p.id === "prof-daily-review") run.summary = `复盘完成：${p.symbols.map((s) => s.split("-")[0]).join(" / ")} 日度结构与资金面已归档${ac.opportunity ? `，生成 ${ac.opportunity} 条待确认机会` : "，无新机会"}。`;
    else if (ac.trade) run.summary = `已执行：${sym} 限价开仓成交，止损已挂出；后续由观察计划跟踪。`;
    else if (ac.opportunity) run.summary = `生成交易机会：${sym} 回踩 ${pf(sym, o.start)} 附近企稳，待确认后执行。`;
    else run.summary = pick([`维持观望：${sym} 结构未破，已更新 ${ac.wake} 条观察条件。`, "无操作：证据不足以支持方向判断，观察位保持不变。", "维持观望：对手盘意见未被推翻，等待确认 K 线。"]);
    // 真实摘要是五个固定小节的 markdown（`background.finishRun` 的排版要求），抽屉要按 markdown 渲染。
    run.summary = [
      "## 结论", run.summary, "",
      "## 事实与证据",
      `- 行情（\`market_readTicker\` · ${fHM(run.finishedAt)}）：${sym} 最新价 ${pf(sym, o.start)}`,
      `- 账户（\`account_readRisk\`）：**无持仓**，保证金充足`, "",
      "## 冲突与缺口", "- 主动流与盘口方向不一致，暂不追价", "",
      "## 观察条件", `- ${sym} 突破 / 跌破关键位 · 每 ${p.scanIntervalMinutes} 分钟复核`, "",
      "## 下一步", "- 等待确认 K 线收盘后再评估"
    ].join("\n");
    run.nextWakeAt = o.nextWakeAt ?? run.finishedAt + p.scanIntervalMinutes * MIN;
    return run;
  }

  // 试判 + 硬升级清单（与 ai_triage.rs::evaluate_triage_escalation 的命名一致）
  function triageDecide(p: FixtureProfile, st: TriageState, t: number, trig: string) {
    const vol = volAt(t);
    const pEsc = trig === "manual" ? 0.85 : trig === "wake_condition" ? (vol ? 0.72 : 0.42) : trig === "event" ? 0.8 : (vol ? 0.5 : 0.075);
    const modelEsc = R() < pEsc;
    const forcedBy: string[] = [];
    if (st.posChanged) forcedBy.push("positionOrOrderChanged");
    if (vol && trig !== "schedule" && R() < 0.3) forcedBy.push("confirmedBreakOfFlaggedLevel");
    if (vol && trig === "wake_condition" && R() < 0.2) forcedBy.push("conditionResonance(3 >= 2)");
    if (trig === "event") forcedBy.push("importantNews");
    if (st.skipStreak >= p.triage.maxSkips) forcedBy.push(`skipStreak(${st.skipStreak} >= ${p.triage.maxSkips})`);
    const since = Math.round((t - st.lastDeep) / MIN);
    if (since > p.triage.maxSilenceMinutes) forcedBy.push(`silenceMinutes(${since} > ${p.triage.maxSilenceMinutes})`);
    const sampled = !modelEsc && !forcedBy.length && R() < p.triage.skipSampleRate;
    const deep = modelEsc || forcedBy.length > 0 || sampled;
    return { verdict: (modelEsc ? "escalate" : "skip") as "escalate" | "skip", forcedBy, sampled, deep };
  }
  function commit(st: TriageState, run: AiAutomationRun) {
    RUNS.push(run);
    st.posChanged = (run.actionCounts?.trade ?? 0) > 0;
    const deep = run.status !== "skipped" && !(run.triage && run.triage.phase === "triage");
    if (deep) { st.lastDeep = run.startedAt; st.skipStreak = 0; } else if (run.status === "skipped") st.skipStreak++;
  }

  // P1：每 15 分钟；最后一格正在深度分析（发光）
  {
    const p = PROFILES[0];
    const st: TriageState = { skipStreak: 0, lastDeep: DATA_START - 40 * MIN, posChanged: false };
    const first = Math.ceil(DATA_START / (15 * MIN)) * 15 * MIN;
    const tradeAt = [EVENTS[1] + 20 * MIN, EVENTS[3] + 35 * MIN];
    const lastSlot = Math.floor(ANCHOR / (15 * MIN)) * 15 * MIN;
    for (let slot = first; slot <= lastSlot; slot += 15 * MIN) {
      const start = slot + between(2, 16) * 1000;
      if (slot === lastSlot) {
        const run = mkRun(p, { start: slot + 7000, trigger: "schedule", verdict: "escalate", forcedBy: [], deep: true, running: true, expertIds: ["market-structure", "contrarian"] });
        const e = run.experts ?? [];
        e[0].startedAt = slot + 62000; e[0].endedAt = slot + 193000; e[0].durationMs = 131000; e[0].toolCalls = 4;
        e[1].startedAt = slot + 205000;
        commit(st, run);
        continue;
      }
      const d = triageDecide(p, st, start, "schedule");
      const trade = d.deep && tradeAt.some((x) => Math.abs(x - start) < 8 * MIN);
      commit(st, mkRun(p, { start, trigger: "schedule", ...d, trade, nextWakeAt: slot + 15 * MIN }));
    }
  }

  // P2：观察计划 / 事件驱动，兜底每 4 小时
  {
    const p = PROFILES[1];
    const st: TriageState = { skipStreak: 0, lastDeep: DATA_START - 3 * HOUR, posChanged: false };
    const cand: { t: number; trig: string; failTriage?: boolean }[] = [];
    EVENTS.forEach((e, i) => {
      if (e > ANCHOR - 30 * MIN) return;
      const n = irand(2, 5);
      for (let k = 0; k < n; k++) cand.push({ t: e + between(-25, 95) * MIN, trig: k === 0 && i % 2 === 0 ? "event" : "wake_condition" });
    });
    for (let t = DATA_START + between(1, 4) * HOUR; t < ANCHOR - 50 * MIN; t += between(3.5, 11) * HOUR) cand.push({ t, trig: "wake_condition" });
    cand.push({ t: ANCHOR - 2.2 * DAY + 3 * HOUR, trig: "manual" }, { t: ANCHOR - 0.93 * DAY, trig: "manual" });
    cand.push({ t: ANCHOR - 3.1 * DAY, trig: "wake_condition", failTriage: true });
    cand.sort((a, b) => a.t - b.t);
    let last = DATA_START;
    const out: typeof cand = [];
    for (const c of cand) {
      while (c.t - last > p.scanIntervalMinutes * MIN) { last += p.scanIntervalMinutes * MIN + between(5, 40) * 1000; out.push({ t: last, trig: "schedule" }); }
      if (c.t - last < p.minWakeIntervalSeconds * 1000) continue;
      out.push(c);
      last = c.t;
    }
    while (ANCHOR - last > p.scanIntervalMinutes * MIN) { last += p.scanIntervalMinutes * MIN + 12000; out.push({ t: last, trig: "schedule" }); }
    out.forEach((c) => {
      if (c.t > ANCHOR - 8 * MIN) return;
      if (c.failTriage) { commit(st, mkRun(p, { start: c.t, trigger: c.trig, verdict: "skip", deep: false, failTriage: true })); return; }
      const d = triageDecide(p, st, c.t, c.trig);
      const nextPlan = c.t + between(70, 230) * MIN;
      commit(st, mkRun(p, { start: c.t, trigger: c.trig, ...d, nextWakeAt: nextPlan }));
    });
  }

  // P3：每日 08:05，未启用试判 → 每次都是深度
  {
    const p = PROFILES[2];
    const st: TriageState = { skipStreak: 0, lastDeep: 0, posChanged: false };
    for (let d = 7; d >= 0; d--) {
      const day = new Date(ANCHOR - d * DAY);
      day.setHours(8, 5, 0, 0);
      const t = day.getTime() + between(1, 40) * 1000;
      if (t < DATA_START || t > ANCHOR) continue;
      commit(st, mkRun(p, { start: t, trigger: "schedule", deep: true, nextWakeAt: day.getTime() + DAY }));
    }
  }

  // P4：每 60 分钟，实盘；含一次失败与一次成交
  {
    const p = PROFILES[3];
    const st: TriageState = { skipStreak: 0, lastDeep: DATA_START - 2 * HOUR, posChanged: false };
    const first = Math.ceil(DATA_START / HOUR) * HOUR;
    const failSlot = Math.floor((ANCHOR - 20.4 * HOUR) / HOUR) * HOUR;
    const tradeSlot = Math.floor((EVENTS[2] + 30 * MIN) / HOUR) * HOUR;
    for (let slot = first; slot < ANCHOR - 2 * MIN; slot += HOUR) {
      const start = slot + 2 * MIN + between(0, 20) * 1000;
      if (start > ANCHOR) break;
      if (slot === failSlot) { commit(st, mkRun(p, { start, trigger: "schedule", verdict: "escalate", forcedBy: [], deep: true, fail: true, expertIds: ["contrarian"] })); continue; }
      const d = slot === tradeSlot ? { verdict: "escalate" as const, forcedBy: [], sampled: false, deep: true } : triageDecide(p, st, start, "schedule");
      commit(st, mkRun(p, { start, trigger: "schedule", ...d, trade: slot === tradeSlot, nextWakeAt: slot + HOUR + 2 * MIN }));
    }
  }

  RUNS.sort((a, b) => a.startedAt - b.startedAt);
  const details = new Map<string, AiAutomationRunDetail>();
  for (const run of RUNS) {
    details.set(run.id, {
      run,
      trigger: { type: run.triggerType, source: "automation-preview" },
      profileSnapshot: null,
      skillVersions: {},
      assistantText: run.summary ?? null,
      toolEvents: [],
      initialMarketSnapshot: null,
      finalDecision: null
    });
  }
  return { anchor: ANCHOR, now, profiles: PROFILES, runs: RUNS, details };
}
