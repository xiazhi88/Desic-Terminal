import type { MarketRadarSnapshotFrames } from "../../types";

// 仅用于浏览器预览（?radarFrames=synthetic）：按真实合约列表生成确定性的回放帧，
// 让星图的回放、彗尾、质心与空洞渲染在没有桌面端快照时也能验证。
// 合约按名称哈希分成若干“板块”，各板块在不同时段轮动；中间留一段空洞，验证空洞如实显示。

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
  const groups = instIds.map((instId) => hash(instId) % 6);
  const random = instIds.map((instId) => rng(hash(instId)));
  const base = instIds.map((_, index) => ({ strength: 30 + random[index]!() * 40, activity: 30 + random[index]!() * 40, calm: 30 + random[index]!() * 40, trend: 30 + random[index]!() * 40, turnover: Math.exp(15 + random[index]!() * 5) }));
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
      const center = (group + 0.5) / 6;
      const boost = Math.exp(-Math.pow((phase - center) / 0.07, 2));
      const item = base[index]!;
      item.strength = Math.min(98, Math.max(2, item.strength + (next() - 0.5) * 3 + (boost - 0.25) * 2.2));
      item.activity = Math.min(98, Math.max(2, item.activity + (next() - 0.5) * 4 + (boost - 0.25) * 3));
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
