import assert from "node:assert/strict";
import { applyIndicatorCommands, maxCommandToken, visibleIndicatorIds } from "../src/lib/chartIndicatorCommands.ts";

const make = (id, token) => ({ id: `new-${id}-${token}`, definitionId: id, visible: true, parameters: {} });
const base = [
  { id: "ma5", definitionId: "ma", visible: true, parameters: { period: 5 } },
  { id: "ma10", definitionId: "ma", visible: true, parameters: { period: 10 } },
  { id: "ema21", definitionId: "ema", visible: false, parameters: { period: 21 } },
];

assert.deepEqual(visibleIndicatorIds(base), ["ma"]);

// add：隐藏的同类指标重新显示，保留用户参数，不新建
let next = applyIndicatorCommands(base, [{ token: 1, op: "add", id: "ema" }], make);
assert.equal(next.length, 3);
assert.deepEqual(next.find((item) => item.id === "ema21"), { id: "ema21", definitionId: "ema", visible: true, parameters: { period: 21 } });

// add：已可见则不重复添加
next = applyIndicatorCommands(base, [{ token: 2, op: "add", id: "ma" }], make);
assert.equal(next.length, 3);

// add：没有同类实例才新建
next = applyIndicatorCommands(base, [{ token: 3, op: "add", id: "rsi" }], make);
assert.equal(next.length, 4);
assert.equal(next[3].id, "new-rsi-3");

// remove：只隐藏该类的全部实例，不删除，参数保留
next = applyIndicatorCommands(base, [{ token: 4, op: "remove", id: "ma" }], make);
assert.equal(next.length, 3);
assert.deepEqual(visibleIndicatorIds(next), []);
assert.deepEqual(next.find((item) => item.id === "ma5").parameters, { period: 5 });

// remove 后 add：撤销闭环，原实例重新可见，不会多出新实例
const round = applyIndicatorCommands(next, [{ token: 5, op: "add", id: "ma" }], make);
assert.equal(round.length, 3);
assert.deepEqual(visibleIndicatorIds(round), ["ma"]);

// 批量指令按顺序生效，且同一批里前面的结果后面可见
next = applyIndicatorCommands(base, [{ token: 6, op: "add", id: "rsi" }, { token: 7, op: "remove", id: "rsi" }, { token: 8, op: "add", id: "rsi" }], make);
assert.equal(next.filter((item) => item.definitionId === "rsi").length, 1, "同类只会有一个实例");
assert.equal(next.find((item) => item.definitionId === "rsi").visible, true);

// 未知指标（createInstance 返回 null）被忽略，不抛错
assert.equal(applyIndicatorCommands(base, [{ token: 9, op: "add", id: "nope" }], () => null).length, 3);

// 输入不被修改
assert.equal(base[0].visible, true);
assert.equal(maxCommandToken([{ token: 3, op: "add", id: "a" }, { token: 9, op: "add", id: "b" }]), 9);
assert.equal(maxCommandToken([]), 0);

console.log("chart indicator command tests passed");
