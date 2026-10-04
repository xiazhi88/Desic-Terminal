import assert from "node:assert/strict";
import { buildVerdict, firstSentence, confidenceLabel } from "../src/lib/aiVerdict.ts";

// 普通问答：没有相关工具调用 → 没有结论卡
assert.equal(buildVerdict([]), null);
assert.equal(buildVerdict([{ name: "market.readCandles", result: {} }]), null);

// 真实形态：创建机会 + 记录决策
const create = {
  name: "tradeOpportunity.create", status: "done", ok: true,
  arguments: { direction: "long", instId: "SOL-USDT-SWAP", price: "118", stopLoss: { triggerPx: "116.2" }, takeProfit: { triggerPx: "123.3" }, size: "0.2", lever: "3", expiresAt: 1791172800000, confidence: 0.5, strategyName: "SOL 区间下沿回调做多（34小时窗口）", invalidationPrice: "116.2" },
  result: { id: "opp1791049559866866021000e96a11de", instId: "SOL-USDT-SWAP", direction: "long" },
};
const decide = { name: "research.recordDecision", status: "done", ok: true, result: { outcome: "long", instId: "SOL-USDT-SWAP", reason: "选SOL做多：证据完整。但现价贴近上沿，因此不追高，改用回调限价单。" } };
const v = buildVerdict([create, decide]);
assert.equal(v.outcome, "long"); assert.equal(v.instId, "SOL-USDT-SWAP");
assert.equal(v.entry, 118); assert.equal(v.stop, 116.2); assert.equal(v.target, 123.3);
assert.ok(Math.abs(v.rewardRisk - (123.3 - 118) / (118 - 116.2)) < 1e-9);
assert.equal(v.size, 0.2); assert.equal(v.leverage, 3); assert.equal(v.confidence, 0.5);
assert.equal(v.opportunityId, "opp1791049559866866021000e96a11de"); assert.equal(v.hasOpportunity, true);
assert.equal(v.headline, "SOL 区间下沿回调做多（34小时窗口）");

// 只有决策（观望）：无价位，也不伪造数字
const w = buildVerdict([{ name: "research.recordDecision", ok: true, result: { outcome: "abstain", reason: "趋势与广度偏空，先观望；等收回通道再说。" } }]);
assert.equal(w.outcome, "abstain"); assert.equal(w.entry, null); assert.equal(w.rewardRisk, null); assert.equal(w.hasOpportunity, false);
assert.equal(w.headline, "趋势与广度偏空，先观望");

// 失败 / 被阻断的调用不算
assert.equal(buildVerdict([{ ...create, ok: false }]), null);
assert.equal(buildVerdict([{ ...create, status: "blocked", blocked: true }]), null);
assert.equal(buildVerdict([{ name: "tradeOpportunity.create", arguments: create.arguments }]), null, "没有结果的调用不算");

// 取最后一次
const later = buildVerdict([create, { ...create, arguments: { ...create.arguments, price: "119" }, result: { id: "opp2" } }]);
assert.equal(later.entry, 119); assert.equal(later.opportunityId, "opp2");

// 止损和入场相等：盈亏比不可算
assert.equal(buildVerdict([{ ...create, arguments: { ...create.arguments, stopLoss: { triggerPx: "118" } } }]).rewardRisk, null);
// 把握度被限制在 0–1
assert.equal(buildVerdict([{ ...create, arguments: { ...create.arguments, confidence: 3 } }]).confidence, 1);
assert.equal(confidenceLabel(0.9), "high"); assert.equal(confidenceLabel(0.5), "mid"); assert.equal(confidenceLabel(0.2), "low");
assert.equal(firstSentence("a".repeat(100), 10).length, 10); assert.equal(firstSentence(""), "");
// 优先在逗号处断开，且不停在未闭合的括号里
assert.equal(firstSentence("全市场呈加密内部普涨(crypto 82.9% 上涨、中位 +2.65%)，但领涨集中在低流动性小市值(STRK/SAND/ZETA 等)，主流币钝化。", 40), "全市场呈加密内部普涨(crypto 82.9% 上涨、中位 +2.65%)…");
assert.ok(!/\([^)]*…$/.test(firstSentence("甲乙丙丁戊己庚辛(未闭合的括号内容很长很长很长很长很长很长很长很长", 20)));
console.log("ai verdict tests passed");
