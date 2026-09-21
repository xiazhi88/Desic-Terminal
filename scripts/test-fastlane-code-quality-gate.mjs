#!/usr/bin/env node
/**
 * **C29.18 验收单测**（2026-09-21）：入场质量门 = **纯代码判据**（不再读 `jev.quality`）。
 *
 * 用法：`node scripts/test-fastlane-code-quality-gate.mjs`（`npm run test:fastlane-gate`）
 * **零网络**：Jev 与窄调用 LLM 全部用桩（`callJevImpl` / `callNarrowLlmImpl`），不调模型、不写库。
 *
 * 覆盖（缺一不可；每条断言都能指出**原因码**）：
 *   ① 问题面：`buildJevQuestions` 删掉 `quality`，保留 `long_score` / `short_score` / `reduce_score` /
 *      `setup_valid`；prompt 里不再引用 `quality` 字段（模型不会去找一个不存在的字段）；
 *   ② 三条判据的**边界**：结构位缺失 → `structure_unclear`；止损过近 / 过远 → `stop_not_placeable`；
 *      R:R < 门槛 → `rr_below_floor`；三条都过 → 放行（`ok: true` 且 `reasons` 为空）；
 *   ③ **回归（关键）**：同一 state 下把 Jev 响应的 `quality` 从 0.1 改到 5.0（以及缺失 / null）→
 *      放行 / 拦下的结论**完全不变**（证明它不再参与判定）；
 *   ④ 降险豁免回归：Jev 判降险 + 门不过（`low_confidence`）→ 仍进动作分支；且入场质量门对降险
 *      **不适用**（`applicable: false`，不产生原因码）；
 *   ⑤ 轮级回归：结构位缺失的开仓轮 → 走观望分支且 `action.reason = structure_unclear`；
 *   ⑥ 源码级断言：三处同源（侧车 / Rust / UI）+ 默认 1.2 + 区间 0.5–3.0 + 三个观望码三处同码 +
 *      i18n en/zh 都有文案 + **判据函数文本里不出现 `quality` 读取**。
 *
 * 变异校验（在 CI 之外手工做过一次，证据写进 `docs/pending.md` C29.18）：
 *   把 `fastlaneDecisionGate` 改回"读 `jev.quality`"→ 本脚本必须**红**（首红行见台账）；还原后逐字节一致。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FASTLANE_DEFAULTS,
  FASTLANE_ENTRY_QUALITY,
  FASTLANE_ENTRY_QUALITY_WATCH_REASONS,
  FASTLANE_QUALITY_FLOOR_MAX,
  FASTLANE_QUALITY_FLOOR_MIN,
  buildActionPrompt,
  buildJevQuestions,
  buildWatchPrompt,
  fastlaneDecisionGate,
  fastlaneEntryQuality,
  fastlaneFirstTarget,
  normalizeJevVerdict,
  runFastlaneRound
} from "./cline-fastlane.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_PATH = resolve(ROOT, "scripts/cline-fastlane.mjs");
const RUST_PATH = resolve(ROOT, "src-tauri/src/fastlane.rs");
const UI_DEFAULTS_PATH = resolve(ROOT, "src/ui/fastlane/fastlaneDefaults.ts");
const I18N_PATH = resolve(ROOT, "src/i18n/resources.ts");
// C29.19：快判模式产品面总开关（Rust 常量 + UI 常量的同源性 + 产品入口按它分叉）。
const UI_MODE_PATH = resolve(ROOT, "src/ui/fastlane/fastlaneMode.ts");
const PANEL_PATH = resolve(ROOT, "src/ui/AiAutomationPanel.tsx");

const CHECKS = [];
function check(name, fn) {
  CHECKS.push({ name, fn });
}

// ───────────────────────── 固定向量（纯合成 state，不读库、不调模型）─────────────────────────

const CONFIG = {
  fastlane_quality_floor: FASTLANE_DEFAULTS.qualityFloor,
  fastlane_confidence_floor: 0.6,
  fastlane_entry_score_floor: 1.5,
  fastlane_reduce_score_floor: 1.5
};

/** 合成 state：entry 100 / ATR14_1h 1.0（阈值 ×ATR 读数即价格距离）。 */
function stateOf({ entry = 100, atr = 1, structure = {}, positions = [] } = {}) {
  return {
    inst_id: "BTC-USDT-SWAP",
    price: { last: entry },
    volatility: { atr14_1h: atr, atr14_5m: 0.25 },
    structure,
    account: { positions, equity_usdt: 10_000 }
  };
}

/** 三条都过的基准 state（做多）：止损锚 99.4（0.6×ATR），上方目标位 102.5（2.5×ATR → R:R 4.17）。 */
const GOOD_STRUCTURE = {
  tf_15m: { last_swing_low: 98.6, last_swing_high: 102.5 },
  tf_1h: { last_swing_low: 99.4, last_swing_high: 103 },
  tf_4h: { last_swing_low: 97, last_swing_high: 105 }
};

const verdict = (action, extra = {}) => ({
  action,
  actionRaw: action,
  probabilities: {},
  confidence: null,
  quality: null,
  longScore: null,
  shortScore: null,
  reduceScore: null,
  entryScoreFloor: null,
  entryScoreDecision: null,
  reduceScoreDecision: null,
  reduceScoreFloor: null,
  reducePositionFact: null,
  entryScoreWatchReason: null,
  confidenceSource: "none",
  ...extra
});

const gateOf = (snapshot, jev) => fastlaneDecisionGate({ jev, config: CONFIG, snapshot });

// ───────────────────────── ① 问题面：删掉 quality ─────────────────────────

check("① buildJevQuestions 删掉 quality，保留其余四问", () => {
  const questions = buildJevQuestions({ inst_id: "BTC-USDT-SWAP" });
  assert.deepEqual(
    Object.keys(questions).sort(),
    ["long_score", "reduce_score", "setup_valid", "short_score"],
    "问题面键集合必须是四个（quality 已删除）"
  );
  assert.ok(!("quality" in questions), "问题面里不得再有 quality");
  for (const key of ["long_score", "short_score", "reduce_score"]) {
    assert.equal(questions[key].type, "score", `${key} 仍必须是 score`);
    assert.equal(questions[key].criteria.length, 5, `${key} 的 5 档锚点必须保留`);
  }
  assert.equal(questions.setup_valid.type, "noul");
  assert.match(questions.long_score.instructions, /做多这一个具体动作/, "long_score 问法逐字未改");
});

check("① prompt 不再引用 Jev 的 quality 字段", () => {
  const snapshot = stateOf({ structure: GOOD_STRUCTURE });
  const jev = { answers: verdict("open_long") };
  const watch = buildWatchPrompt({ snapshot, jev, config: CONFIG });
  const action = buildActionPrompt({ snapshot, jev, config: CONFIG });
  // `【jev_decision】` 是**判定回显**（如实反映侧车给出的判定体，里面允许出现 quality：老响应带值、
  // 新响应为 `null`）；指令模板（system + 除回显外的 user 段）里**一个字都不能有** quality ——
  // 否则模型会去找一个已经不存在的字段。
  const stripEcho = (text) => text.replace(/【jev_decision】[\s\S]*?【current_wake_conditions】/, "【jev_decision】（回显）");
  for (const [name, prompt] of [["buildWatchPrompt", watch], ["buildActionPrompt", action]]) {
    assert.ok(!/quality/i.test(prompt.system), `${name} 的 system 段不得引用 quality`);
    assert.ok(
      !/quality/i.test(stripEcho(prompt.user)),
      `${name} 的指令段不得引用 quality（只有判定回显里允许出现）`
    );
  }
  // 老响应**带** quality 时：它只会出现在 `【jev_decision】` 的 JSON 回显里（如实留痕），
  // 指令段（prompt 模板）里一个字都不该有。
  const legacy = { answers: verdict("open_long", { quality: 1.61 }) };
  const withLegacy = `${buildWatchPrompt({ snapshot, jev: legacy, config: CONFIG }).user}`;
  assert.ok(/quality/.test(withLegacy), "老响应的 quality 必须照实回显（可复核）");
  const instructionsOnly = withLegacy.replace(/【jev_decision】[\s\S]*?【current_wake_conditions】/, "【jev_decision】…【current_wake_conditions】");
  assert.ok(!/quality/i.test(instructionsOnly), "指令段不得引用 quality（只有判定回显里允许出现）");
});

// ───────────────────────── ② 三条判据的边界（逐条给出原因码）─────────────────────────

check("② 三条都过 → 放行（ok: true / reasons 为空）", () => {
  const gate = gateOf(stateOf({ structure: GOOD_STRUCTURE }), verdict("open_long"));
  assert.equal(gate.ok, true, `三条都过必须放行，实际 reasons=${JSON.stringify(gate.reasons)}`);
  assert.deepEqual(gate.reasons, []);
  assert.equal(gate.entryQuality.applicable, true);
  assert.equal(gate.entryQuality.structure_ok, true);
  assert.equal(gate.entryQuality.stop_placeable, true);
  assert.equal(gate.entryQuality.rr_ok, true);
  assert.ok(gate.entryQuality.rr >= CONFIG.fastlane_quality_floor, "R:R 必须 ≥ 门槛");
});

check("② 结构位缺失 → structure_unclear", () => {
  const gate = gateOf(stateOf({ structure: {} }), verdict("open_long"));
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.reasons, [FASTLANE_ENTRY_QUALITY_WATCH_REASONS.structure]);
  assert.equal(gate.reasons[0], "structure_unclear");
  assert.equal(gate.entryQuality.structure_ok, false);
  assert.equal(gate.entryQuality.stop_placeable, null, "结构不过 → 后面的判据不评估（不是 false，是没评）");
});

check("② 只有单侧结构位 → structure_unclear", () => {
  const gate = gateOf(
    stateOf({ structure: { tf_1h: { last_swing_low: 99.4 } } }),
    verdict("open_long")
  );
  assert.deepEqual(gate.reasons, ["structure_unclear"], "做多只有下方参考位、没有上方目标位 → 结构不可辨");
});

check("② 结构位离现价太远（> 3×ATR）→ structure_unclear", () => {
  const gate = gateOf(
    stateOf({ structure: { tf_1h: { last_swing_low: 90, last_swing_high: 110 } }, atr: 1 }),
    verdict("open_long")
  );
  assert.deepEqual(gate.reasons, ["structure_unclear"], "最近结构位 10×ATR ⇒ 不构成近端结构");
  assert.ok(gate.entryQuality.nearest_structure_atr > FASTLANE_ENTRY_QUALITY.maxStructureAtr);
});

check("② ATR14_1h 缺失 → structure_unclear（算不出可用距离就不做）", () => {
  const gate = gateOf(
    stateOf({ structure: GOOD_STRUCTURE, atr: null }),
    verdict("open_long")
  );
  assert.deepEqual(gate.reasons, ["structure_unclear"]);
});

check("② 止损过近（0.10×ATR < 0.25）→ stop_not_placeable", () => {
  // 止损锚只离现价 0.1×ATR（会被单根 5m K 线扫掉）；上方有远目标位（R:R 足够），
  // 所以这一条必须由 stop_placeable 而不是 rr_ok 拦下。
  const gate = gateOf(
    stateOf({ structure: { tf_1h: { last_swing_low: 99.9, last_swing_high: 103 } } }),
    verdict("open_long")
  );
  assert.deepEqual(gate.reasons, ["stop_not_placeable"]);
  assert.equal(gate.entryQuality.structure_ok, true);
  assert.equal(gate.entryQuality.stop_placeable, false);
  assert.ok(
    gate.entryQuality.stop_distance_atr < FASTLANE_ENTRY_QUALITY.minStopAtr,
    `止损距离 ${gate.entryQuality.stop_distance_atr} 必须小于下限 ${FASTLANE_ENTRY_QUALITY.minStopAtr}`
  );
});

check("② 止损过远（结构锚 3×ATR > 1.5）→ stop_not_placeable", () => {
  // 结构锚 97（3×ATR）⇒ 纪律止损退化成纯 ATR 距离（entry − 1.5×ATR）—— 风险不再由结构承载。
  const gate = gateOf(
    stateOf({ structure: { tf_1h: { last_swing_low: 97, last_swing_high: 106 } } }),
    verdict("open_long")
  );
  assert.deepEqual(gate.reasons, ["stop_not_placeable"]);
  assert.ok(
    gate.entryQuality.stop_anchor_atr > FASTLANE_ENTRY_QUALITY.maxAnchorAtr,
    `结构锚 ${gate.entryQuality.stop_anchor_atr}×ATR 必须超过上限 ${FASTLANE_ENTRY_QUALITY.maxAnchorAtr}`
  );
  assert.equal(gate.entryQuality.stop_distance_atr, FASTLANE_ENTRY_QUALITY.atrStopBuffer, "退化成纪律的 1.5×ATR");
});

check("② 做空对称：止损过近 / 过远都拦，全过放行", () => {
  const short = (low, high) => stateOf({ structure: { tf_1h: { last_swing_low: low, last_swing_high: high } } });
  assert.deepEqual(gateOf(short(97, 100.1), verdict("open_short")).reasons, ["stop_not_placeable"], "做空止损过近");
  assert.deepEqual(gateOf(short(94, 103), verdict("open_short")).reasons, ["stop_not_placeable"], "做空止损过远");
  const good = gateOf(short(96, 100.6), verdict("open_short"));
  assert.equal(good.ok, true, `做空三条都过必须放行，实际 ${JSON.stringify(good.reasons)}`);
});

check("② R:R < 门槛 → rr_below_floor（结构 / 止损都能过）", () => {
  // 止损锚 99.4（0.6×ATR，过）；上方只有 100.5（距离 0.5 < 1R ⇒ 付不起这份风险）→ 没有合格目标位。
  const gate = gateOf(
    stateOf({ structure: { tf_1h: { last_swing_low: 99.4, last_swing_high: 100.5 } } }),
    verdict("open_long")
  );
  assert.deepEqual(gate.reasons, [FASTLANE_ENTRY_QUALITY_WATCH_REASONS.rr]);
  assert.equal(gate.reasons[0], "rr_below_floor");
  assert.equal(gate.entryQuality.structure_ok, true);
  assert.equal(gate.entryQuality.stop_placeable, true);
  assert.equal(gate.entryQuality.rr_ok, false);
  assert.equal(gate.entryQuality.rr, null, "没有合格目标位 → R:R 无值（不编造）");
});

check("② R:R 门槛可配：同一 state 在 1.2 放行、在 1.6 拦（阈值真的起作用）", () => {
  // 止损锚 99.4（R = 0.6）；上方最近合格目标位 101.0（距离 1.0 → R:R = 1.667）。
  const snapshot = stateOf({ structure: { tf_1h: { last_swing_low: 99.4, last_swing_high: 101.0 } } });
  const at = (floor) => fastlaneDecisionGate({
    jev: verdict("open_long"),
    config: { ...CONFIG, fastlane_quality_floor: floor },
    snapshot
  });
  assert.equal(at(1.2).ok, true, "1.2 下限应放行（R:R 1.667）");
  assert.equal(at(1.6).ok, true, "1.6 下限仍放行（R:R 1.667 ≥ 1.6）");
  assert.equal(at(2.0).ok, false, "2.0 下限应拦下（R:R 1.667 < 2.0）");
  assert.deepEqual(at(2.0).reasons, ["rr_below_floor"]);
});

check("② 三条判据的阈值全部是常量且与注释依据同源", () => {
  assert.equal(FASTLANE_ENTRY_QUALITY.maxStructureAtr, 3.0);
  assert.equal(FASTLANE_ENTRY_QUALITY.minStopAtr, 0.25);
  assert.equal(FASTLANE_ENTRY_QUALITY.maxAnchorAtr, 1.5);
  assert.equal(FASTLANE_ENTRY_QUALITY.atrStopBuffer, 1.5, "止损公式里的 ATR 缓冲 = hardConstraints 原文的 1.5");
  assert.equal(FASTLANE_ENTRY_QUALITY.targetBarR, 1.0, "「能付得起这份风险」= 至少 1R");
  assert.equal(FASTLANE_QUALITY_FLOOR_MIN, 0.5);
  assert.equal(FASTLANE_QUALITY_FLOOR_MAX, 3.0);
  assert.equal(FASTLANE_DEFAULTS.qualityFloor, 1.2, "默认 1.2（宽起步）");
});

check("② 目标位取数与 C29.15「第一目标」同一函数（只换门槛参数）", () => {
  const levels = [
    { tf: "tf_1h", key: "last_swing_high", value: 100.5 },
    { tf: "tf_1h", key: "window_high", value: 103 },
    { tf: "tf_1h", key: "window_high", value: 106 }
  ];
  // barR = 1（能付得起这份风险）：最近合格位 = 100.5；barR = 1.5：最近合格位 = 103。
  assert.equal(fastlaneFirstTarget({ levels, entry: 100, direction: "long", risk: 0.5, barR: 1 }).value, 100.5);
  assert.equal(fastlaneFirstTarget({ levels, entry: 100, direction: "long", risk: 0.5, barR: 1.5 }).value, 103);
  assert.equal(fastlaneFirstTarget({ levels, entry: 100, direction: "long", risk: 0.5, barR: 20 }), null, "够不着 → null");
});

// ───────────────────────── ③ 回归：quality 不参与判定 ─────────────────────────

check("③ 回归：quality 0.1 / 5.0 / null / 缺失 → 结论完全一致（放行侧）", () => {
  const snapshot = stateOf({ structure: GOOD_STRUCTURE });
  const variants = [
    verdict("open_long", { quality: 0.1 }),
    verdict("open_long", { quality: 5.0 }),
    verdict("open_long", { quality: null }),
    verdict("open_long")
  ].map((jev) => gateOf(snapshot, jev));
  const baseline = JSON.stringify(variants[0]);
  for (const [index, gate] of variants.entries()) {
    assert.equal(JSON.stringify(gate), baseline, `quality 变体 #${index} 的判定结果必须逐字相同`);
    assert.equal(gate.ok, true, "quality 再低也不得拦下（它只是观察量）");
    assert.ok(!gate.reasons.includes("low_quality"), "不得再产生 low_quality");
  }
});

check("③ 回归：quality 0.1 / 5.0 → 结论完全一致（拦下侧）", () => {
  const snapshot = stateOf({ structure: {} });
  const low = gateOf(snapshot, verdict("open_long", { quality: 0.1 }));
  const high = gateOf(snapshot, verdict("open_long", { quality: 5.0 }));
  assert.deepEqual(low, high, "拦下侧也必须与 quality 无关");
  assert.deepEqual(low.reasons, ["structure_unclear"], "拦下的原因必须是代码判据，不是 low_quality");
});

check("③ 回归：轮级（真实 runFastlaneRound + 桩）quality 改了，分支不变", async () => {
  const snapshot = stateOf({ structure: GOOD_STRUCTURE });
  const run = (quality) => runFastlaneRound({
    sessionId: "test-quality-regression",
    snapshot,
    config: CONFIG,
    typesafeApiKey: "TEST_KEY",
    createOpportunity: async () => ({ id: "opp-test" }),
    callJevImpl: async () => ({
      ok: true, latencyMs: 1, attempts: 1, raw: {}, tokens: { in: 0, out: 0 },
      verdict: normalizeJevVerdict({ answers: { quality: { score: quality }, long_score: { score: 3.0 }, short_score: { score: 0.5 } } }, { config: CONFIG, snapshot })
    }),
    callNarrowLlmImpl: async () => ({
      ok: true, latencyMs: 1, attempts: 1, model: "stub", tokens: { in: 0, out: 0 },
      content: JSON.stringify({
        summary: "stub",
        order: { intent: "open", direction: "long", order_type: "limit", entry_px: 99.9, stop_px: 99.4, tp: [{ px: 102.5, portion: 1 }], size: { contracts: 1 } },
        nextWakePlan: { mode: "any", conditions: [{ type: "price_cross", params: { instId: "BTC-USDT-SWAP", px: 100 } }], expiresAtMs: 4_102_444_800_000 }
      })
    }),
    emit: () => {}
  });
  const low = await run(0.1);
  const high = await run(5.0);
  assert.equal(low.action.kind, "opportunity", "quality 0.1 也必须进动作分支");
  assert.equal(high.action.kind, "opportunity");
  assert.equal(low.gate.ok, true, "门必须过（三条代码判据都过）");
  assert.equal(low.gate.ok, high.gate.ok);
  assert.deepEqual(low.gate.reasons, high.gate.reasons);
  assert.equal(low.gate.entryQuality.rr_ok, true);
  assert.equal(JSON.stringify(low.gate.entryQuality), JSON.stringify(high.gate.entryQuality));
});

// ───────────────────────── ④ 降险豁免回归 ─────────────────────────

check("④ 入场质量门对降险**不适用**（不产生任何原因码）", () => {
  const broken = stateOf({ structure: {} });
  const reduce = verdict("reduce");
  const entryQuality = fastlaneEntryQuality({ snapshot: broken, config: CONFIG, jev: reduce });
  assert.equal(entryQuality.applicable, false);
  assert.equal(entryQuality.skipReason, "no_direction");
  assert.deepEqual(entryQuality.reasons, [], "降险轮不得被入场质量门拦");
  const gate = gateOf(broken, reduce);
  assert.equal(gate.ok, true, "没有方向 → 入场质量门不参与 → 门不过的理由只能来自置信度门");
  assert.deepEqual(gate.reasons, []);
});

check("④ 降险轮：门不过（low_confidence）+ 结构位全缺 → 仍进动作分支", async () => {
  const snapshot = stateOf({ structure: {}, positions: [{ instId: "BTC-USDT-SWAP", posSide: "long", pos: 3 }] });
  const result = await runFastlaneRound({
    sessionId: "test-reduce-bypass",
    snapshot,
    config: CONFIG,
    typesafeApiKey: "TEST_KEY",
    createOpportunity: async () => ({ id: "opp-reduce-test" }),
    callJevImpl: async () => ({
      ok: true, latencyMs: 1, attempts: 1, raw: {}, tokens: { in: 0, out: 0 },
      // 旧形状 action choice（confidence 0.3 < 0.6 → 置信度门不过）；结构位全缺。
      verdict: normalizeJevVerdict(
        { answers: { action: { choice: "减仓", confidence: 0.3 } } },
        { config: CONFIG, snapshot }
      )
    }),
    callNarrowLlmImpl: async () => ({
      ok: true, latencyMs: 1, attempts: 1, model: "stub", tokens: { in: 0, out: 0 },
      content: JSON.stringify({
        summary: "降险",
        order: { intent: "close", direction: "long", order_type: "market", entry_px: null, size: { contracts: 1 }, exit_kind: "strategy_exit" },
        nextWakePlan: { mode: "any", conditions: [{ type: "price_cross", params: { instId: "BTC-USDT-SWAP", px: 100 } }], expiresAtMs: 4_102_444_800_000 }
      })
    }),
    emit: () => {}
  });
  assert.equal(result.jev.action, "reduce", "Jev 判定必须是降险");
  assert.equal(result.gate.ok, false, "门没过必须照实上报（不许改写成 true）");
  assert.deepEqual(result.gate.reasons, ["low_confidence"]);
  assert.equal(result.gate.bypassedFor, "risk_reduction");
  assert.equal(result.gate.appliedTo, "open");
  assert.equal(result.action.kind, "opportunity", "降险不受这道门约束 → 仍进动作分支");
});

// ───────────────────────── ⑤ 轮级：开仓被代码判据拦下 ─────────────────────────

check("⑤ 结构位缺失的开仓轮 → 观望且 action.reason = structure_unclear", async () => {
  const snapshot = stateOf({ structure: {} });
  const result = await runFastlaneRound({
    sessionId: "test-structure-blocked",
    snapshot,
    config: CONFIG,
    typesafeApiKey: "TEST_KEY",
    createOpportunity: async () => ({ id: "never" }),
    callJevImpl: async () => ({
      ok: true, latencyMs: 1, attempts: 1, raw: {}, tokens: { in: 0, out: 0 },
      verdict: normalizeJevVerdict({ answers: { long_score: { score: 3.0 }, short_score: { score: 0.2 } } }, { config: CONFIG, snapshot })
    }),
    callNarrowLlmImpl: async () => ({
      ok: true, latencyMs: 1, attempts: 1, model: "stub", tokens: { in: 0, out: 0 },
      content: JSON.stringify({
        summary: "结构不可辨，等下一轮",
        reason: "no_setup",
        nextWakePlan: { mode: "any", conditions: [{ type: "price_cross", params: { instId: "BTC-USDT-SWAP", px: 100 } }], expiresAtMs: 4_102_444_800_000 }
      })
    }),
    emit: () => {}
  });
  assert.equal(result.jev.action, "open_long", "方向由代码按分数判出");
  assert.equal(result.action.kind, "watch");
  assert.equal(result.action.reason, "structure_unclear", "观望原因必须是代码判据的原因码");
  assert.equal(result.gate.ok, false);
  assert.equal(result.gate.entryQuality.applicable, true);
  assert.equal(result.gate.entryQuality.structure_ok, false);
  assert.ok(!result.gate.reasons.includes("low_quality"));
});

// ───────────────────────── ⑥ 源码级断言（三处同源）─────────────────────────

const sidecarSource = readFileSync(SIDECAR_PATH, "utf8");
const rustSource = readFileSync(RUST_PATH, "utf8");
const uiSource = readFileSync(UI_DEFAULTS_PATH, "utf8");
const i18nSource = readFileSync(I18N_PATH, "utf8");

const readNumber = (source, pattern, label) => {
  const matched = source.match(pattern);
  assert.ok(matched, `源码里找不到 ${label}`);
  return Number(matched[1]);
};

check("⑥ 三处同源：默认 1.2 + 区间 0.5–3.0（源码文本直读）", () => {
  const sidecarDefault = readNumber(sidecarSource, /qualityFloor: ([0-9.]+),/, "侧车 qualityFloor");
  const rustDefault = readNumber(rustSource, /pub const FASTLANE_DEFAULT_QUALITY_FLOOR: f64 = ([0-9.]+);/, "Rust FASTLANE_DEFAULT_QUALITY_FLOOR");
  const uiDefault = readNumber(uiSource, /^ {2}qualityFloor: ([0-9.]+),$/m, "UI qualityFloor");
  assert.equal(sidecarDefault, 1.2, "侧车默认必须是 1.2");
  assert.equal(rustDefault, 1.2, "Rust 默认必须是 1.2");
  assert.equal(uiDefault, 1.2, "UI 默认必须是 1.2");
  assert.equal(new Set([sidecarDefault, rustDefault, uiDefault]).size, 1, "三处默认必须同值");
  const mins = [
    readNumber(sidecarSource, /FASTLANE_QUALITY_FLOOR_MIN = ([0-9.]+);/, "侧车 MIN"),
    readNumber(rustSource, /pub const FASTLANE_QUALITY_FLOOR_MIN: f64 = ([0-9.]+);/, "Rust MIN"),
    readNumber(uiSource, /FASTLANE_QUALITY_FLOOR_MIN = ([0-9.]+);/, "UI MIN")
  ];
  const maxs = [
    readNumber(sidecarSource, /FASTLANE_QUALITY_FLOOR_MAX = ([0-9.]+);/, "侧车 MAX"),
    readNumber(rustSource, /pub const FASTLANE_QUALITY_FLOOR_MAX: f64 = ([0-9.]+);/, "Rust MAX"),
    readNumber(uiSource, /FASTLANE_QUALITY_FLOOR_MAX = ([0-9.]+);/, "UI MAX")
  ];
  assert.deepEqual(mins, [0.5, 0.5, 0.5], "三处下界必须都是 0.5");
  assert.deepEqual(maxs, [3.0, 3.0, 3.0], "三处上界必须都是 3.0");
  // 夹取点必须引用常量（不是手抄数字）。
  assert.match(rustSource, /clamp_finite\(\s*\n?\s*self\.quality_floor,\s*\n?\s*FASTLANE_QUALITY_FLOOR_MIN,/, "Rust 必须用常量夹取");
  assert.match(uiSource, /qualityFloor: Math\.min\(FASTLANE_QUALITY_FLOOR_MAX, Math\.max\(FASTLANE_QUALITY_FLOOR_MIN,/, "UI 必须用常量夹取");
});

check("⑥ 三处同源：三个观望码同码（侧车 / Rust / UI）+ i18n en/zh 有文案", () => {
  const codes = ["structure_unclear", "stop_not_placeable", "rr_below_floor"];
  assert.deepEqual(
    Object.values(FASTLANE_ENTRY_QUALITY_WATCH_REASONS).sort(),
    [...codes].sort(),
    "侧车的三码常量"
  );
  for (const code of codes) {
    assert.ok(
      new RegExp(`"${code}"`).test(sidecarSource),
      `侧车源码缺码：${code}`
    );
    assert.ok(
      new RegExp(`^\\s*"${code}",$`, "m").test(rustSource),
      `Rust FASTLANE_WATCH_REASONS 缺码：${code}`
    );
    assert.ok(
      new RegExp(`^\\s*"${code}",$`, "m").test(uiSource),
      `UI FASTLANE_WATCH_REASONS 缺码：${code}`
    );
    const i18nHits = (i18nSource.match(new RegExp(`fastlaneWatchReason_${code}:`, "g")) || []).length;
    assert.equal(i18nHits, 2, `i18n（en + zh）必须各有一条 fastlaneWatchReason_${code}，实际 ${i18nHits}`);
  }
  // `low_quality` 保留（老记录）但不再是代码侧产物。
  assert.ok(/^\s*"low_quality",$/m.test(rustSource), "老码 low_quality 必须保留在冻结枚举里");
  assert.ok(/^\s*"low_quality",$/m.test(uiSource), "老码 low_quality 必须保留在 UI 枚举里");
});

check("⑥ 判据函数文本里不读 quality（唯一实现的机械证明）", () => {
  /**
   * 从函数声明起切出**函数体**（注释与参数里的说明文字不算判据文本）：
   * 先跳过参数表（括号配平到 0），再从函数体那个 `{` 做花括号配对。
   */
  const bodyOf = (marker) => {
    const start = sidecarSource.indexOf(marker);
    assert.ok(start >= 0, `找不到 ${marker}`);
    let paren = 0;
    let open = -1;
    for (let index = start; index < sidecarSource.length; index += 1) {
      const ch = sidecarSource[index];
      if (ch === "(") paren += 1;
      else if (ch === ")") paren -= 1;
      else if (ch === "{" && paren === 0) {
        open = index;
        break;
      }
    }
    assert.ok(open > start, `找不到 ${marker} 的函数体起点`);
    let depth = 0;
    for (let index = open; index < sidecarSource.length; index += 1) {
      if (sidecarSource[index] === "{") depth += 1;
      else if (sidecarSource[index] === "}") {
        depth -= 1;
        if (depth === 0) return sidecarSource.slice(open, index + 1);
      }
    }
    throw new Error(`花括号不配对：${marker}`);
  };
  const entryQualityBody = bodyOf("export function fastlaneEntryQuality(");
  const gateBody = bodyOf("export function fastlaneDecisionGate(");
  for (const [name, body] of [["fastlaneEntryQuality", entryQualityBody], ["fastlaneDecisionGate", gateBody]]) {
    assert.ok(!/quality\s*\?\.|jev\.quality|\.quality\b/.test(body), `${name} 的判据文本里不得出现 quality 读取`);
    assert.ok(!/low_quality"/.test(body), `${name} 不得再产生 low_quality`);
  }
  assert.match(gateBody, /fastlaneEntryQuality\(/, "门必须由代码判据驱动");
});

check("⑥ quality 仍被解析（老响应用）但只作观察量", () => {
  const snapshot = stateOf({ structure: GOOD_STRUCTURE });
  const parsed = normalizeJevVerdict(
    { answers: { quality: { score: 1.61 }, long_score: { score: 3.0 }, short_score: { score: 0.4 } } },
    { config: CONFIG, snapshot }
  );
  assert.equal(parsed.quality, 1.61, "老响应的 quality 照旧读出来（观察量）");
  assert.equal(parsed.action, "open_long");
  assert.equal(gateOf(snapshot, parsed).reasons.length, 0, "它不影响判定");
});

// ───────────────────────── ⑦ C29.19：产品面总开关（同源 + 产品入口按它分叉）─────────────────────────

const uiModeSource = readFileSync(UI_MODE_PATH, "utf8");
const panelSource = readFileSync(PANEL_PATH, "utf8");

const rustModeEnabled = /pub const FASTLANE_MODE_ENABLED: bool = (true|false);/.exec(rustSource)?.[1];
const uiModeEnabled = /export const FASTLANE_MODE_ENABLED = (true|false);/.exec(uiModeSource)?.[1];

check("⑦ 开关同源：Rust 与 UI 常量同值、都是显式布尔（本版本 false）", () => {
  assert.ok(rustModeEnabled, "Rust 必须显式声明 pub const FASTLANE_MODE_ENABLED: bool = …");
  assert.ok(uiModeEnabled, "UI 必须显式声明 export const FASTLANE_MODE_ENABLED = …");
  assert.equal(rustModeEnabled, uiModeEnabled, "Rust 与 UI 的开关必须同值（翻一处等于没翻）");
  // 本版本（C29.19）的发布状态：**未开放**。下个版本把两处同时改 true 时，这条断言是唯一要改的地方。
  assert.equal(rustModeEnabled, "false", "本版本不发布快判模式 → 两处开关都必须是 false");
  assert.match(
    rustSource,
    /pub const FASTLANE_MODE_DISABLED_REASON: &str =/,
    "关闭态必须有一条**明确原因**常量（要求不静默）"
  );
});

check("⑦ 关闭态：产品面入口全部按开关分叉（不是删代码）", () => {
  // 三个产品面入口必须逐条读同一个开关：选择器卡片 / 独立配置窗口 / 运行记录快判卡片。
  // 断言与开关**同生共死**：下个版本翻 true 时这三行仍在（只是结果不同），因此不写 `if`。
  const gates = [
    [/fastlaneEnabled=\{FASTLANE_MODE_ENABLED\}/, "新建 Profile 选择器的快判卡片必须按开关渲染"],
    [/\{FASTLANE_MODE_ENABLED && profileEditorOpen/, "快判配置窗口入口必须按开关渲染"],
    [/const isFastlaneRun = FASTLANE_MODE_ENABLED/, "运行记录的快判卡片必须按开关渲染"]
  ];
  for (const [pattern, label] of gates) {
    assert.ok(pattern.test(panelSource), `${label}（${pattern}）`);
  }
  // 组件本体必须保留（撤下 ≠ 删除）：选择器卡片定义与两个快判组件都还在。
  assert.match(panelSource, /import \{ FastlaneConfigDialog \} from "\.\/fastlane\/FastlaneConfigDialog"/, "FastlaneConfigDialog 的导入必须保留");
  assert.match(panelSource, /import \{ FastlaneRunRecord \} from "\.\/fastlane\/FastlaneRunRecord"/, "FastlaneRunRecord 的导入必须保留");
  const cardsSource = readFileSync(resolve(ROOT, "src/ui/fastlane/ProfileTypeCards.tsx"), "utf8");
  assert.match(cardsSource, /type: "fastlane"/, "快判卡片定义必须保留在 ProfileTypeCards 里");
  assert.match(cardsSource, /fastlaneEnabled\s*\n?\s*\? cards\s*\n?\s*: cards\.filter/, "卡片过滤必须由开关驱动（不是删掉卡片定义）");
  // 侧车与 Rust 常量本体一行不删。
  assert.ok(sidecarSource.includes("export function fastlaneDecisionGate("), "侧车本体必须保持原样");
  assert.ok(rustSource.includes("pub const FASTLANE_RECORD_KIND"), "Rust 记录种类常量必须保留");
});

// ───────────────────────── 跑 ─────────────────────────

let failures = 0;
for (const { name, fn } of CHECKS) {
  try {
    await fn();
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`  FAIL ${name}\n`);
    process.stdout.write(`       ${String(error?.message || error).split("\n").join("\n       ")}\n`);
  }
}
process.stdout.write(`\n[fastlane-code-quality-gate] ${CHECKS.length - failures}/${CHECKS.length} checks passed\n`);
if (failures > 0) process.exit(1);
