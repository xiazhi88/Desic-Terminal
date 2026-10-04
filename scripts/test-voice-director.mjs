import assert from "node:assert/strict";
import { parseDirectorCommand, parseSpokenNumber } from "../src/lib/voice/directorCommands.ts";
import { runDirectorActions } from "../src/lib/voice/directorExecutor.ts";

const catalog = {
  instruments: [
    { instId: "BTC-USDT-SWAP", baseCcy: "BTC" },
    { instId: "ETH-USDT-SWAP", baseCcy: "ETH" },
    { instId: "SOL-USDT-SWAP", baseCcy: "SOL" },
    { instId: "DOGE-USDT-SWAP", baseCcy: "DOGE" },
    { instId: "BTC-USD-SWAP", baseCcy: "BTC" },
  ],
  indicatorIds: ["ma", "ema", "boll", "rsi", "macd", "vwap", "volume-ma", "obv"],
};

const actions = (text) => {
  const result = parseDirectorCommand(text, catalog);
  assert.equal(result.kind, "actions", `应识别为动作：${text} → ${JSON.stringify(result)}`);
  return result.actions;
};
const kind = (text) => parseDirectorCommand(text, catalog).kind;

// 口述数字
assert.equal(parseSpokenNumber("十二"), 12);
assert.equal(parseSpokenNumber("三十"), 30);
assert.equal(parseSpokenNumber("十五"), 15);
assert.equal(parseSpokenNumber("两"), 2);
assert.equal(parseSpokenNumber("二十四"), 24);
assert.equal(parseSpokenNumber("abc"), null);

// 切合约
assert.deepEqual(actions("切到 SOL"), [{ type: "instrument", instId: "SOL-USDT-SWAP" }]);
assert.deepEqual(actions("看一下比特币"), [{ type: "instrument", instId: "BTC-USDT-SWAP" }]);
assert.deepEqual(actions("看看以太"), [{ type: "instrument", instId: "ETH-USDT-SWAP" }]);
assert.deepEqual(actions("eth-usdt-swap"), [{ type: "instrument", instId: "ETH-USDT-SWAP" }]);

// 周期
assert.deepEqual(actions("四小时"), [{ type: "timeframe", bar: "4H" }]);
assert.deepEqual(actions("切换到 15 分钟"), [{ type: "timeframe", bar: "15m" }]);
assert.deepEqual(actions("半小时"), [{ type: "timeframe", bar: "30m" }]);
assert.deepEqual(actions("日线"), [{ type: "timeframe", bar: "1D" }]);
assert.deepEqual(actions("十二小时"), [{ type: "timeframe", bar: "12H" }]);
assert.deepEqual(actions("switch to 4h"), [{ type: "timeframe", bar: "4H" }]);
assert.equal(kind("七分钟"), "unrecognized", "不存在的周期不能猜");
assert.equal(kind("二十四小时"), "unrecognized");

// 合约 + 周期 + 指标：同一句话
assert.deepEqual(actions("看 ETH 4 小时，加 EMA"), [
  { type: "instrument", instId: "ETH-USDT-SWAP" },
  { type: "timeframe", bar: "4H" },
  { type: "indicator", op: "add", id: "ema" },
]);
assert.deepEqual(actions("切到 SOL 然后一小时再加 RSI"), [
  { type: "instrument", instId: "SOL-USDT-SWAP" },
  { type: "timeframe", bar: "1H" },
  { type: "indicator", op: "add", id: "rsi" },
]);

// 指标：长别名优先，增删方向正确
assert.deepEqual(actions("加上指数均线"), [{ type: "indicator", op: "add", id: "ema" }]);
assert.deepEqual(actions("加均线"), [{ type: "indicator", op: "add", id: "ma" }]);
assert.deepEqual(actions("加 MACD"), [{ type: "indicator", op: "add", id: "macd" }], "ma 不能抢走 macd");
assert.deepEqual(actions("去掉布林带"), [{ type: "indicator", op: "remove", id: "boll" }]);
assert.deepEqual(actions("remove rsi"), [{ type: "indicator", op: "remove", id: "rsi" }]);
assert.deepEqual(actions("清空指标"), [{ type: "clearIndicators" }]);
assert.deepEqual(actions("加成交量均线"), [{ type: "indicator", op: "add", id: "volume-ma" }]);

// 订单流
assert.deepEqual(actions("打开订单流"), [{ type: "orderFlow", enabled: true }]);
assert.deepEqual(actions("关闭订单流"), [{ type: "orderFlow", enabled: false }]);
assert.deepEqual(actions("turn off order flow"), [{ type: "orderFlow", enabled: false }]);

// 工作区
assert.deepEqual(actions("打开雷达"), [{ type: "workspace", section: "radar" }]);
assert.deepEqual(actions("去情报"), [{ type: "workspace", section: "intelligence" }]);
assert.deepEqual(actions("策略研究"), [{ type: "workspace", section: "systematic" }]);
assert.deepEqual(actions("打开设置"), [{ type: "workspace", section: "config" }]);
assert.equal(kind("打开雷达看 ETH"), "unrecognized", "工作区与合约意图矛盾，不猜");

// 回归：英文口语词不能被当成同名币（ON / AI），"图""和"要当作口语词
const collisionCatalog = { ...catalog, instruments: [...catalog.instruments, { instId: "ON-USDT-SWAP", baseCcy: "ON" }] };
assert.deepEqual(parseDirectorCommand("turn on order flow", collisionCatalog), { kind: "actions", actions: [{ type: "orderFlow", enabled: true }] });
assert.deepEqual(parseDirectorCommand("on-usdt-swap", collisionCatalog), { kind: "actions", actions: [{ type: "instrument", instId: "ON-USDT-SWAP" }] });
assert.deepEqual(actions("看一下 ETH 的 4 小时图"), [{ type: "instrument", instId: "ETH-USDT-SWAP" }, { type: "timeframe", bar: "4H" }]);
assert.deepEqual(actions("加 ma 和 ema"), [{ type: "indicator", op: "add", id: "ema" }, { type: "indicator", op: "add", id: "ma" }]);
assert.deepEqual(actions("日线 RSI"), [{ type: "timeframe", bar: "1D" }, { type: "indicator", op: "add", id: "rsi" }], "同一句内按 周期→指标 的固定顺序");

// 撤销
assert.equal(kind("撤销"), "undo");
assert.equal(kind("撤销。"), "undo");
assert.equal(kind("undo"), "undo");

// 交易类动词：整句拒绝，语音绝不直接成交
for (const text of ["买入 BTC", "做多 ETH", "做空 SOL 十倍", "平仓", "把仓位全平", "下单", "buy ETH", "go long", "加仓", "切到 ETH 然后做多"]) {
  assert.equal(kind(text), "trade-refused", `应拒绝：${text}`);
}

// 疑问句不是下单指令：交给语音指挥分析，而不是直接拒绝
for (const text of ["ETH 现在该不该做多", "要不要平仓", "BTC 能不能买入", "现在做空合适吗", "should I go long", "how is the market for a buy"]) {
  assert.equal(kind(text), "unrecognized", `疑问句应交给 AI：${text}`);
}
for (const text of ["做多 ETH", "买入 BTC", "平仓", "sell now"]) assert.equal(kind(text), "trade-refused", `指令句仍然拒绝：${text}`);

// 认不出的整句交给 AI，而不是执行一半
for (const text of ["", "   ", "帮我分析一下支撑位", "切到 SOL 然后画一条压力线", "今天天气怎么样", "加个不存在的指标 xyz"]) {
  assert.equal(kind(text), "unrecognized", `应交给 AI：${text}`);
}
assert.equal(kind("看 BTC 和 ETH"), "unrecognized", "多个合约存在歧义");
assert.equal(kind("加 bollinger band 指标"), "unrecognized", "夹杂未知词时不能误执行");

// ---- 执行器 ----
function makeController(initial) {
  const state = { section: "terminal", symbol: "BTC-USDT-SWAP", bar: "30m", orderFlow: false, indicatorIds: ["ma"], ...initial };
  const log = [];
  return {
    state,
    log,
    snapshot: () => ({ ...state, indicatorIds: [...state.indicatorIds] }),
    setSection: (section) => { state.section = section; log.push(`section:${section}`); },
    setInstrument: (instId) => { state.symbol = instId; state.section = "terminal"; log.push(`instrument:${instId}`); },
    setTimeframe: (bar) => { state.bar = bar; log.push(`bar:${bar}`); },
    setOrderFlow: (enabled) => { state.orderFlow = enabled; log.push(`flow:${enabled}`); },
    addIndicator: (id) => { if (!state.indicatorIds.includes(id)) state.indicatorIds.push(id); log.push(`add:${id}`); },
    removeIndicator: (id) => { state.indicatorIds = state.indicatorIds.filter((item) => item !== id); log.push(`remove:${id}`); },
  };
}
const run = (list, controller, extra = {}) => runDirectorActions(list, controller, { stepDelayMs: 0, ...extra });

{
  const controller = makeController({ section: "radar" });
  const steps = [];
  const result = await run(
    [
      { type: "instrument", instId: "ETH-USDT-SWAP" },
      { type: "timeframe", bar: "4H" },
      { type: "indicator", op: "add", id: "ema" },
      { type: "indicator", op: "add", id: "ma" },
      { type: "orderFlow", enabled: true },
    ],
    controller,
    { onStep: (index, status) => steps.push(`${index}:${status}`) },
  );
  assert.deepEqual(result.statuses, ["done", "done", "done", "skipped", "done"], "已存在的指标应跳过");
  assert.equal(result.changed, true);
  assert.deepEqual(controller.state, { section: "terminal", symbol: "ETH-USDT-SWAP", bar: "4H", orderFlow: true, indicatorIds: ["ma", "ema"] });
  assert.deepEqual(steps.slice(0, 2), ["0:running", "0:done"]);

  result.undo();
  assert.deepEqual(controller.state, { section: "radar", symbol: "BTC-USDT-SWAP", bar: "30m", orderFlow: false, indicatorIds: ["ma"] }, "撤销应完全还原，包括工作区");
}

{
  // 同一句话里先加后删：推演状态必须互相可见
  const controller = makeController();
  const result = await run([{ type: "indicator", op: "add", id: "rsi" }, { type: "indicator", op: "remove", id: "rsi" }], controller);
  assert.deepEqual(result.statuses, ["done", "done"]);
  assert.deepEqual(controller.state.indicatorIds, ["ma"]);
  result.undo();
  assert.deepEqual(controller.state.indicatorIds, ["ma"]);
}

{
  // 清空指标可撤销
  const controller = makeController({ indicatorIds: ["ma", "ema", "rsi"] });
  const result = await run([{ type: "clearIndicators" }], controller);
  assert.deepEqual(controller.state.indicatorIds, []);
  result.undo();
  assert.deepEqual([...controller.state.indicatorIds].sort(), ["ema", "ma", "rsi"]);
}

{
  // 全部无变化：不算改动，也不产生撤销副作用
  const controller = makeController();
  const result = await run([{ type: "instrument", instId: "BTC-USDT-SWAP" }, { type: "timeframe", bar: "30m" }, { type: "orderFlow", enabled: false }], controller);
  assert.deepEqual(result.statuses, ["skipped", "skipped", "skipped"]);
  assert.equal(result.changed, false);
  assert.deepEqual(controller.log, []);
}

{
  // 中途停止：后续步骤标为取消，已执行的仍可撤销
  const controller = makeController();
  const abort = new AbortController();
  const result = await run(
    [{ type: "timeframe", bar: "1H" }, { type: "timeframe", bar: "4H" }, { type: "timeframe", bar: "1D" }],
    controller,
    { signal: abort.signal, onStep: (index, status) => { if (index === 0 && status === "done") abort.abort(); } },
  );
  assert.deepEqual(result.statuses, ["done", "cancelled", "cancelled"]);
  assert.equal(controller.state.bar, "1H");
  result.undo();
  assert.equal(controller.state.bar, "30m");
}

console.log("voice director tests passed");

// ---- AI ui.* 事件校验 ----
const { parseUiActionEvent, UI_TIMEFRAMES, UI_WORKSPACES } = await import("../src/lib/voice/uiToolActions.ts");
const { DIRECTOR_TIMEFRAMES } = await import("../src/lib/voice/directorCommands.ts");
assert.deepEqual([...UI_TIMEFRAMES], [...DIRECTOR_TIMEFRAMES], "两份周期清单必须一致");
assert.equal(UI_WORKSPACES.length, 9);
const ev = (toolName, payload) => parseUiActionEvent({ toolName, payload }, catalog);
assert.deepEqual(ev("ui.setInstrument", { instId: "eth-usdt-swap" }), [{ type: "instrument", instId: "ETH-USDT-SWAP" }]);
assert.equal(ev("ui.setInstrument", { instId: "DOGEE-USDT-SWAP" }), null, "目录里没有的合约不能执行");
assert.deepEqual(ev("ui.setTimeframe", { bar: "4H" }), [{ type: "timeframe", bar: "4H" }]);
assert.equal(ev("ui.setTimeframe", { bar: "7m" }), null);
assert.deepEqual(ev("ui.addIndicator", { indicator: "rsi" }), [{ type: "indicator", op: "add", id: "rsi" }]);
assert.deepEqual(ev("ui.removeIndicator", { indicator: "rsi" }), [{ type: "indicator", op: "remove", id: "rsi" }]);
assert.equal(ev("ui.addIndicator", { indicator: "nope" }), null);
assert.deepEqual(ev("ui.setOrderFlow", { enabled: false }), [{ type: "orderFlow", enabled: false }]);
assert.equal(ev("ui.setOrderFlow", { enabled: "yes" }), null, "布尔值必须是真布尔");
assert.deepEqual(ev("ui.openWorkspace", { section: "radar" }), [{ type: "workspace", section: "radar" }]);
assert.equal(ev("ui.openWorkspace", { section: "trade" }), null);
assert.equal(ev("trade.placeOrder", { instId: "BTC-USDT-SWAP" }), null, "非 ui.* 工具一律忽略");
assert.equal(ev("ui.placeOrder", {}), null, "未登记的 ui.* 也忽略");
assert.equal(parseUiActionEvent(null, catalog), null);
assert.equal(parseUiActionEvent({}, catalog), null);
console.log("ui tool action tests passed");

// ---- 语音指挥会话：事件归约 / 工具映射 / 噪声过滤 ----
const { reduceVoiceAgentEvent, INITIAL_VOICE_AGENT_STATE, workspaceForTool, isLikelyNoise, VOICE_AGENT_RULES, toolLabel, toolTarget, voiceReasoningDepth } = await import("../src/lib/voice/voiceAgentModel.ts");
let st = INITIAL_VOICE_AGENT_STATE;
st = reduceVoiceAgentEvent(st, { type: "delta", channel: "reasoning", content: "思考中" });
assert.equal(st.text, "", "推理文字不显示");
st = reduceVoiceAgentEvent(st, { type: "delta", channel: "text-preview", content: "ETH 现在" });
st = reduceVoiceAgentEvent(st, { type: "delta", channel: "text-preview", content: "ETH 现在偏弱。" });
assert.equal(st.text, "ETH 现在偏弱。", "预览通道是整段替换而不是追加");
st = reduceVoiceAgentEvent(st, { type: "delta", channel: "text", content: "（旁白）" });
assert.equal(st.text, "ETH 现在偏弱。", "出现预览后不再追加零散旁白");
st = reduceVoiceAgentEvent(st, { type: "toolCall", toolCallId: "t1", name: "radar.readBreadth" });
st = reduceVoiceAgentEvent(st, { type: "toolCall", toolCallId: "t1", name: "radar.readBreadth" });
st = reduceVoiceAgentEvent(st, { type: "toolCall", toolCallId: "t2", name: "x", policy: "rust:tool-execute-request" });
assert.equal(st.tools.length, 1, "同 id 去重、内部转发事件忽略");
st = reduceVoiceAgentEvent(st, { type: "toolResult", toolCallId: "t1", name: "radar.readBreadth", ok: true });
assert.equal(st.tools[0].status, "done");
st = reduceVoiceAgentEvent(st, { type: "delta", channel: "text-final", content: "全市场偏弱，建议观望。" });
st = reduceVoiceAgentEvent(st, { type: "done", finishReason: "stop" });
assert.equal(st.status, "done"); assert.equal(st.text, "全市场偏弱，建议观望。");
assert.equal(reduceVoiceAgentEvent(st, { type: "error", message: "late" }).status, "done", "结束后忽略迟到事件");
let nopreview = reduceVoiceAgentEvent(INITIAL_VOICE_AGENT_STATE, { type: "delta", channel: "text", content: "你好，" });
nopreview = reduceVoiceAgentEvent(nopreview, { type: "delta", channel: "text", content: "世界" });
assert.equal(nopreview.text, "你好，世界", "没有预览通道时逐段追加");
assert.equal(reduceVoiceAgentEvent(INITIAL_VOICE_AGENT_STATE, { type: "error", message: "模型不可用" }).error, "模型不可用");
assert.equal(reduceVoiceAgentEvent(INITIAL_VOICE_AGENT_STATE, { type: "done", finishReason: "cancelled" }).status, "cancelled");
assert.equal(reduceVoiceAgentEvent(INITIAL_VOICE_AGENT_STATE, { type: "done", finishReason: "error" }).status, "failed");
assert.equal(workspaceForTool("radar.readRanking"), "radar");
assert.equal(workspaceForTool("intelligence.news.search"), "intelligence");
assert.equal(workspaceForTool("strategy.backtest"), "systematic");
assert.equal(workspaceForTool("tradeOpportunity.list"), "opportunities");
assert.equal(workspaceForTool("market.readTicker"), null, "行情读取不跳转");
assert.equal(workspaceForTool("account.readPositions"), null);
assert.equal(workspaceForTool("ui.setInstrument"), null, "ui.* 由执行器处理");
for (const noise of ["Okay.", "ok", "嗯", "啊。", "Thank you.", "you", "  ", "。", "好", "a"]) assert.equal(isLikelyNoise(noise), true, `应判为噪声：${noise}`);
for (const real of ["切到 SOL", "帮我看一下以太", "ETH 怎么样", "加 RSI", "雷达里谁最强"]) assert.equal(isLikelyNoise(real), false, `不应判为噪声：${real}`);
assert.ok(VOICE_AGENT_RULES.length < 1200, "附加规则要在 Rust 侧的 1200 字符上限内");
console.log("voice agent model tests passed");

// 回答文字整理：去 Markdown、先说结论、证据卡停留时长
{
  const { plainSpeech, splitLead, cardHoldMs, stagePlanMs, VOICE_AGENT_RULES } = await import("../src/lib/voice/voiceAgentModel.ts");
  const plain = plainSpeech("BTC 我的结论：**不追，暂不做方向**。现在 84603。\n\n- 上方 85500 压制\n- 下方 83800 支撑\n# 小结\n`破位` 才考虑；见 [详情](https://x.test/a)。");
  assert.ok(!/[*`#]|\]\(/.test(plain), plain);
  assert.ok(!plain.includes("\n"));
  assert.ok(plain.includes("不追，暂不做方向") && plain.includes("上方 85500 压制") && plain.includes("见 详情"));
  const { lead, rest } = splitLead("先观望。BTC 在区间中部震荡，资金费率接近零，持仓量持平，没有新的催化。再多看一根 4H 收盘。", 30);
  assert.ok(lead.startsWith("先观望。") && rest.length > 0);
  assert.equal(splitLead("").lead, "");
  assert.equal(splitLead("只有一句话。").rest, "");
  assert.equal(splitLead("A. B. C.", 3).lead.length > 0, true);
  assert.equal(cardHoldMs("短"), 2200);
  assert.equal(cardHoldMs("x".repeat(200)), 4200);
  assert.equal(stagePlanMs([{ claim: "短" }, { claim: "短" }], { reason: "短" }), 3 * 2200);
  assert.equal(stagePlanMs([], null), 0);
  assert.ok(VOICE_AGENT_RULES.includes("Markdown"));
  console.log("voice answer text tests passed");
}


// ---- 多步分析：证据卡片 / 决策 / 来源 / 步骤轨迹 ----
{
  let a = INITIAL_VOICE_AGENT_STATE;
  a = reduceVoiceAgentEvent(a, { type: "toolCall", toolCallId: "c1", name: "market.readCandles", arguments: { instId: "ETH-USDT-SWAP", bar: "4H" } });
  assert.equal(a.tools[0].target, "ETH", "目标取合约并去掉后缀");
  a = reduceVoiceAgentEvent(a, { type: "toolResult", toolCallId: "c1", name: "market.readCandles", ok: true, summary: "ETH 4H 近 50 根 K 线，下降通道", result: JSON.stringify({ evidenceRef: "E1", rows: 3 }) });
  assert.equal(a.sources.E1.tool, "market.readCandles");
  assert.match(a.sources.E1.summary, /下降通道/);
  a = reduceVoiceAgentEvent(a, { type: "toolResult", toolCallId: "c2", name: "research.recordEvidence", ok: true, result: { items: [
    { id: "b1", claim: "4H 仍处下降通道", stance: "bear", weight: 2.4, sourceRefs: ["E1"] },
    { id: "b2", claim: "资金费率转负", stance: "bull", weight: 1, sourceRefs: ["E2", "E3"] },
    { id: "bad", claim: "", stance: "bear", weight: 1, sourceRefs: [] },
    { id: "bad2", claim: "立场非法", stance: "up", weight: 1, sourceRefs: [] },
  ] } });
  assert.deepEqual(a.evidence.map((e) => e.id), ["b1", "b2"], "非法条目被丢弃");
  a = reduceVoiceAgentEvent(a, { type: "toolResult", toolCallId: "c3", name: "research_recordEvidence", ok: true, result: JSON.stringify({ items: [{ id: "b1", claim: "4H 下降通道已被收复", stance: "neutral", weight: 5, sourceRefs: ["E1"] }] }) });
  assert.equal(a.evidence.length, 2, "同 id 重新记录是覆盖，不新增");
  assert.equal(a.evidence[0].stance, "neutral"); assert.equal(a.evidence[0].weight, 3, "权重夹到 0–3");
  a = reduceVoiceAgentEvent(a, { type: "toolResult", toolCallId: "c4", name: "research.recordDecision", ok: true, result: { outcome: "abstain", reason: "证据冲突，先观望", instId: "ETH-USDT-SWAP" } });
  assert.deepEqual(a.decision, { outcome: "abstain", reason: "证据冲突，先观望", instId: "ETH-USDT-SWAP" });
  const failed = reduceVoiceAgentEvent(INITIAL_VOICE_AGENT_STATE, { type: "toolResult", toolCallId: "x", name: "research.recordEvidence", ok: false, result: { items: [{ id: "z", claim: "不应出现", stance: "bull", weight: 1, sourceRefs: ["E1"] }] } });
  assert.equal(failed.evidence.length, 0, "失败的账本调用不产生卡片");
  assert.equal(reduceVoiceAgentEvent(INITIAL_VOICE_AGENT_STATE, { type: "toolResult", name: "research.recordDecision", ok: true, result: { outcome: "buy", reason: "x" } }).decision, null, "非法决策结果被忽略");
}
assert.equal(toolTarget({ instId: "BTC-USDT-SWAP" }), "BTC");
assert.equal(toolTarget({ bar: "1H" }), "1H");
assert.equal(toolTarget("not an object"), null);
assert.deepEqual(toolLabel("radar.readBreadth"), ["查看市场宽度", "Checking breadth"]);
assert.deepEqual(toolLabel("research_recordEvidence"), ["整理证据", "Organising evidence"], "provider 形式的名字也能识别");
assert.deepEqual(toolLabel("totally.unknown"), ["调用工具", "Using a tool"]);
assert.equal(voiceReasoningDepth("ETH 现在该不该做多"), "medium");
assert.equal(voiceReasoningDepth("how is the market"), "medium");
assert.equal(voiceReasoningDepth("切到 SOL"), "low");
assert.ok(VOICE_AGENT_RULES.includes("research.recordEvidence") && VOICE_AGENT_RULES.includes("research.recordDecision"));
console.log("voice evidence tests passed");

// ---- 纠错词表 ----
const { applyCorrections, learnCorrection, mergeEntry, sanitizeEntries, joinSpacedLetters, DEFAULT_CORRECTIONS } = await import("../src/lib/voice/lexicon.ts");
assert.equal(applyCorrections("加布灵带指标").text, "加布林带指标", "内置：长词优先于短词");
assert.equal(applyCorrections("看一下以太方").text, "看一下以太坊");
assert.equal(applyCorrections("加 R S I").text, "加 RSI", "逐字母读出的指标合并");
assert.equal(applyCorrections("add M A C D now").text, "add MACD now");
assert.equal(applyCorrections("RSI is fine").text, "RSI is fine", "已经合并的不再动");
assert.equal(applyCorrections("a b").text, "a b", "小写单字母不合并");
assert.equal(applyCorrections("加 M A").text, "加 MA", "两个大写字母也合并（MA 均线）");
assert.deepEqual(applyCorrections("切到索拉那").changes, [{ from: "索拉那", to: "索拉纳" }]);
assert.equal(applyCorrections("没有需要改的").changes.length, 0);
// 用户词表优先
assert.equal(applyCorrections("切换座椅", [{ from: "座椅", to: "以太" }]).text, "切换以太");
assert.equal(applyCorrections("加 ema", [{ from: "EMA", to: "ema" }]).text, "加 ema", "ASCII 不区分大小写匹配");
assert.equal(applyCorrections("macdx", [{ from: "macd", to: "MACD" }]).text, "macdx", "ASCII 按词边界，不误改单词内部");
// 学习
assert.deepEqual(learnCorrection("切换座椅菜方", "切换以太坊"), { from: "座椅菜方", to: "以太坊" });
assert.deepEqual(learnCorrection("加布令带", "加布林带"), { from: "令", to: "林" });
assert.equal(learnCorrection("一样", "一样"), null);
assert.equal(learnCorrection("切到 SOL", "帮我重新分析一下今天整个市场的情况"), null, "整句重写不学");
assert.equal(learnCorrection("", "x"), null);
// 合并与清洗
const merged = mergeEntry([{ from: "座椅", to: "以太" }, { from: "A", to: "B" }], { from: "座椅", to: "以太坊" });
assert.deepEqual(merged[0], { from: "座椅", to: "以太坊" }); assert.equal(merged.length, 2, "同 from 覆盖");
assert.equal(sanitizeEntries([{ from: "x", to: "x" }, { from: "", to: "y" }, null, { from: "a".repeat(40), to: "b" }, { from: "ok", to: "好" }]).length, 1);
assert.ok(DEFAULT_CORRECTIONS.every((e) => e.from !== e.to));
console.log("voice lexicon tests passed");
