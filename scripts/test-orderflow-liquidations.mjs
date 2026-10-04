import assert from "node:assert/strict";
import { clusterLiquidations, pickLabelledClusters } from "../src/ui/chart/orderFlowModel.ts";

const mark = (size, side = "long", time = 1) => ({ time, price: 1, size, side });
const point = (x, y, size, side, time) => ({ x, y, mark: mark(size, side, time) });

// 同方向、同格子合并：数量求和、条数累加、重心按数量加权、时间取最近
const merged = clusterLiquidations([point(100, 50, 10, "long", 5), point(104, 52, 30, "long", 9), point(101, 50, 10, "long", 7)], 16);
assert.equal(merged.length, 1);
assert.equal(merged[0].size, 50); assert.equal(merged[0].count, 3); assert.equal(merged[0].time, 9);
assert.ok(Math.abs(merged[0].x - (100 * 10 + 104 * 30 + 101 * 10) / 50) < 1e-9);

// 多空不合并；不同格子不合并
assert.equal(clusterLiquidations([point(100, 50, 5, "long"), point(100, 50, 5, "short")], 16).length, 2);
assert.equal(clusterLiquidations([point(0, 0, 5, "long"), point(40, 0, 5, "long")], 16).length, 2);
assert.deepEqual(clusterLiquidations([], 16), []);

// 500 条挤在 6 处踩踏里：聚合后簇的数量远小于条数，总量守恒
const dense = [];
for (let i = 0; i < 500; i += 1) dense.push(point(100 + (i % 6) * 200 + (i % 7), 300 + (i % 5) * 3, 1 + (i % 9), i % 3 ? "long" : "short", i));
const clusters = clusterLiquidations(dense, 16);
assert.ok(clusters.length <= 24, `聚合后应当很少，实际 ${clusters.length}`);
assert.equal(clusters.reduce((sum, c) => sum + c.size, 0), dense.reduce((sum, p) => sum + p.mark.size, 0));
assert.equal(clusters.reduce((sum, c) => sum + c.count, 0), 500);

// 标注：最多 max 个、都不重叠、都不小于最大簇的 minShare
const labelled = pickLabelledClusters(clusters, { max: 4, gapX: 110, gapY: 20, minShare: 0.3 });
assert.ok(labelled.size >= 1 && labelled.size <= 4);
const list = [...labelled];
for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) assert.ok(Math.abs(list[i].x - list[j].x) >= 110 || Math.abs(list[i].y - list[j].y) >= 20, "标注不得互相重叠");
const top = Math.max(...clusters.map((c) => c.size));
assert.ok(list.every((c) => c.size >= top * 0.3));
// 最大的簇一定被标注
assert.ok(labelled.has(clusters.find((c) => c.size === top)));
// 太小的不标；空输入不报错
assert.equal(pickLabelledClusters([{ x: 0, y: 0, size: 100, count: 1, side: "long", time: 1 }, { x: 500, y: 0, size: 5, count: 1, side: "long", time: 1 }]).size, 1);
assert.equal(pickLabelledClusters([]).size, 0);
console.log("orderflow liquidation tests passed");
