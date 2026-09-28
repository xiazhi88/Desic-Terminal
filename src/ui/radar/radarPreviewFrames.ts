import type { MarketRadarSnapshotFrames } from "../../types";
import { radarSectorOf, RADAR_SECTORS } from "../../lib/radarSectors";

// 仅用于浏览器预览（?radarFrames=synthetic）：按真实合约列表生成确定性的回放帧，
// 让星图的回放、彗尾、质心与空洞渲染在没有桌面端快照时也能验证。
// 合约按 radarSectors 归类，各板块在不同时段轮动（带动量的随机游走，避免逐帧抖动）；
// 中间留一段空洞，验证空洞如实显示。

function hash(text: string) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PreviewAnchor = { composite: number; strength: number; lowVolatility: number; activity: number; trendQuality: number; change: number; turnover: number };

/** anchors：当前实时值；合成序列在最后 15% 平滑收敛到它，回放末端与实时端衔接。 */
export function buildPreviewSnapshotFrames(instIds: string[], categories: Array<string | null>, days: number, stepHours: number, now: number, anchors: PreviewAnchor[] = []): MarketRadarSnapshotFrames {
  const hour = 3_600_000;
  const step = stepHours * hour;
  const end = Math.floor(now / hour) * hour - hour;
  const count = Math.min(400, Math.floor((days * 24) / stepHours));
  const times = Array.from({ length: count }, (_, index) => end - (count - 1 - index) * step);
  // 模拟一段应用未运行的空洞（约占 6%）。
  const gapStart = Math.floor(count * 0.58);
  const gapEnd = gapStart + Math.max(2, Math.floor(count * 0.06));
  const kept = times.filter((_, index) => index < gapStart || index >= gapEnd);
  const n = instIds.length;
  const sectorCount = RADAR_SECTORS.length;
  const groups = instIds.map((instId, index) => RADAR_SECTORS.findIndex((sector) => sector.id === radarSectorOf(instId, categories[index])));
  const random = instIds.map((instId) => rng(hash(instId)));
  // 起点贴近当前实时值（有锚点时），回放末端与实时帧自然衔接，不会在最后几帧大幅跳跃。
  const near = (anchor: number | undefined, index: number) => (anchor === undefined ? 30 + random[index]!() * 40 : Math.min(98, Math.max(2, anchor + (random[index]!() - 0.5) * 24)));
  const base = instIds.map((_, index) => ({ strength: near(anchors[index]?.strength, index), activity: near(anchors[index]?.activity, index), calm: near(anchors[index]?.lowVolatility, index), trend: near(anchors[index]?.trendQuality, index), turnover: anchors[index]?.turnover ?? Math.exp(15 + random[index]!() * 5), vs: 0, va: 0, home: { strength: 0, activity: 0 } }));
  for (const item of base) item.home = { strength: item.strength, activity: item.activity };
  const frames = kept.map((time) => {
    const phase = (time - times[0]!) / Math.max(1, times.at(-1)! - times[0]!);
    const composite: number[] = [];
    const strength: number[] = [];
    const lowVolatility: number[] = [];
    const activity: number[] = [];
    const trendQuality: number[] = [];
    const change: number[] = [];
    const turnover: number[] = [];
    for (let index = 0; index < n; index += 1) {
      const next = random[index]!;
      const group = groups[index]!;
      // 每个板块有一段轮动窗口：窗口内强度与活跃度抬升。
      const center = ((group * 5) % sectorCount + 0.5) / sectorCount;
      const boost = group === sectorCount - 1 ? 0 : Math.exp(-Math.pow((phase - center) / 0.09, 2));
      const item = base[index]!;
      // 速度带动量（AR(1)），位置只积分速度：轨迹平滑、方向可读。
      item.vs = 0.86 * item.vs + (next() - 0.5) * 0.9 + (boost - 0.2) * 0.5 * stepHours;
      item.va = 0.86 * item.va + (next() - 0.5) * 1.1 + (boost - 0.2) * 0.7 * stepHours;
      // 弱均值回归：合成序列围绕起点游走，不会一路漂出坐标区。
      item.strength = Math.min(98, Math.max(2, item.strength + item.vs + 0.03 * (item.home.strength - item.strength)));
      item.activity = Math.min(98, Math.max(2, item.activity + item.va + 0.03 * (item.home.activity - item.activity)));
      item.calm = Math.min(98, Math.max(2, item.calm + (next() - 0.5) * 2 - boost * 1.2));
      item.trend = Math.min(98, Math.max(2, item.trend + (next() - 0.5) * 2.5 + boost));
      const anchor = anchors[index];
      const w = anchor ? Math.min(1, Math.max(0, (phase - 0.85) / 0.15)) ** 2 : 0;
      const blend = (synthetic: number, live: number | undefined) => (live === undefined ? synthetic : synthetic + (live - synthetic) * w);
      strength.push(blend(item.strength, anchor?.strength));
      activity.push(blend(item.activity, anchor?.activity));
      lowVolatility.push(blend(item.calm, anchor?.lowVolatility));
      trendQuality.push(blend(item.trend, anchor?.trendQuality));
      composite.push(blend(item.strength * 0.4 + item.activity * 0.25 + item.calm * 0.15 + item.trend * 0.2, anchor?.composite));
      change.push(blend((boost * 9 + (next() - 0.5) * 6) * (group % 2 === 0 ? 1 : 0.7), anchor?.change));
      turnover.push(blend(item.turnover * (1 + boost * 2), anchor?.turnover));
    }
    const order = composite.map((value, index) => [value, index] as const).sort((left, right) => right[0] - left[0]);
    const rank = new Array<number>(n);
    order.forEach(([, index], position) => { rank[index] = position + 1; });
    return { snapshotAt: time, rank, composite, strength, lowVolatility, activity, trendQuality, change24hPct: change, turnover24h: turnover };
  });
  return {
    instIds,
    categories,
    frames,
    snapshotsInRange: frames.length,
    firstSnapshotAt: frames[0]?.snapshotAt ?? null,
    lastSnapshotAt: frames.at(-1)?.snapshotAt ?? null,
    stepHours
  };
}
