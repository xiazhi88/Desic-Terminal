import type { MarketRadarResearchScore, MarketRadarSnapshotFrames } from "../../types";
import type { MarketRadarRow } from "../../lib/marketRadar";
import { buildRadarSnapshotInput } from "../../lib/marketRadarSnapshot";
import { radarSectorOf, radarSectorOrder } from "../../lib/radarSectors";

// 星图数据模型：把后端列式快照帧 + 当前实时行统一成稠密数组。
// 坐标轴因子在每一帧内做横截面标准化再软饱和到 0–100（50 = 当帧均值）：存储的是加权分，
// 量纲随模型版本变化，标准化只保留相对位置；软饱和让极端值渐近而不贴边，主体呈中心云团。

export const CONSTELLATION_FACTORS = ["composite", "strength", "lowVolatility", "activity", "trendQuality"] as const;
export type ConstellationFactor = (typeof CONSTELLATION_FACTORS)[number];

export type ConstellationModel = {
  instIds: string[];
  labels: string[];
  categories: string[];
  /** 每帧的快照时间（ms，升序）；实时帧在最后。 */
  frameTimes: number[];
  /** 相邻两帧之间是否存在快照空洞（长度 = frames - 1）。 */
  gapAfter: boolean[];
  liveIndex: number | null;
  count: number;
  frames: number;
  valid: Uint8Array;
  factors: Record<ConstellationFactor, Float32Array>;
  /** 综合评分原值（未标准化），详情面板展示用。 */
  compositeRaw: Float32Array;
  /** 24h 涨跌，单位 %。 */
  change: Float32Array;
  turnover: Float32Array;
  rank: Float32Array;
  /** 每帧的上涨占比（市场宽度），用于时间轴背景曲线。 */
  breadth: Float32Array;
  /** 每帧有效合约数。 */
  validCount: Uint32Array;
  /** 板块（按 radarSectors 归类）去重后的展示顺序。 */
  sectors: string[];
  /** 从数据中检测到的板块轮动 / 宽度极值事件，按时间升序。 */
  events: ConstellationEvent[];
};

export type ConstellationEvent = {
  frame: number;
  time: number;
  kind: "sector-up" | "sector-down" | "breadth-up" | "breadth-down";
  sector: string | null;
  /** 板块事件：24h 内板块平均综合位置变化（0–100 尺度）；宽度事件：上涨占比。 */
  value: number;
};

type FrameValues = {
  time: number;
  rows: Array<{ index: number; rank: number; factors: Record<ConstellationFactor, number | null>; change: number; turnover: number }>;
};

// 横截面标准化 + tanh 软饱和（与原型相同的 50 + 48·tanh(17z/48)）。并列值得到同一坐标。
function softScores(values: Array<number | null>): Array<number | null> {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    n += 1;
    sum += value;
    sumSq += value * value;
  }
  if (n === 0) return values.map(() => null);
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(1e-12, sumSq / n - mean * mean));
  return values.map((value) => (value === null || !Number.isFinite(value) ? null : 50 + 48 * Math.tanh((17 * ((value - mean) / sd)) / 48)));
}

export function buildConstellationModel(frames: MarketRadarSnapshotFrames | null, liveRows: MarketRadarRow[], researchScores: MarketRadarResearchScore[], liveAt: number | null): ConstellationModel {
  const instIds: string[] = [];
  const categories: string[] = [];
  const indexOf = new Map<string, number>();
  const ensure = (instId: string, category: string | null | undefined) => {
    const existing = indexOf.get(instId);
    if (existing !== undefined) return existing;
    indexOf.set(instId, instIds.length);
    instIds.push(instId);
    categories.push(radarSectorOf(instId, category));
    return instIds.length - 1;
  };

  const collected: FrameValues[] = [];
  if (frames) {
    frames.instIds.forEach((instId, position) => ensure(instId, frames.categories[position]));
    for (const frame of frames.frames) {
      const rows: FrameValues["rows"] = [];
      frames.instIds.forEach((instId, position) => {
        const rank = frame.rank[position];
        if (rank === null || rank === undefined) return;
        rows.push({
          index: indexOf.get(instId)!,
          rank,
          factors: {
            composite: frame.composite[position] ?? null,
            strength: frame.strength[position] ?? null,
            lowVolatility: frame.lowVolatility[position] ?? null,
            activity: frame.activity[position] ?? null,
            trendQuality: frame.trendQuality[position] ?? null
          },
          change: frame.change24hPct[position] ?? 0,
          turnover: frame.turnover24h[position] ?? 0
        });
      });
      collected.push({ time: frame.snapshotAt, rows });
    }
  }

  let liveIndex: number | null = null;
  if (liveRows.length > 0 && liveAt) {
    // 实时帧与写入小时快照使用同一套加权口径，回放末端与实时端连续。
    const input = buildRadarSnapshotInput(liveRows, researchScores, liveAt);
    const rows: FrameValues["rows"] = input.rows.map((row) => ({
      index: ensure(row.instId, row.category),
      rank: row.rank,
      factors: {
        composite: row.compositeScore,
        strength: row.strengthScore,
        lowVolatility: row.lowVolatilityScore,
        activity: row.rawActivityScore,
        trendQuality: row.rawTrendQualityScore ?? row.trendQualityScore
      },
      change: row.change24hPct,
      turnover: row.turnover24h
    }));
    const lastSnapshot = collected.at(-1)?.time ?? -Infinity;
    // 实时时刻若与最后一个小时快照同属一小时，以实时帧替换，避免同一小时两帧。
    if (Math.floor(lastSnapshot / 3_600_000) === Math.floor(liveAt / 3_600_000)) collected.pop();
    collected.push({ time: liveAt, rows });
    liveIndex = collected.length - 1;
  }

  const count = instIds.length;
  const frameCount = collected.length;
  const valid = new Uint8Array(frameCount * count);
  const factors = Object.fromEntries(CONSTELLATION_FACTORS.map((factor) => [factor, new Float32Array(frameCount * count)])) as Record<ConstellationFactor, Float32Array>;
  const change = new Float32Array(frameCount * count);
  const compositeRaw = new Float32Array(frameCount * count);
  const validCount = new Uint32Array(frameCount);
  const turnover = new Float32Array(frameCount * count);
  const rank = new Float32Array(frameCount * count);
  const breadth = new Float32Array(frameCount);
  collected.forEach((frame, frameIndex) => {
    const base = frameIndex * count;
    let rising = 0;
    for (const row of frame.rows) {
      valid[base + row.index] = 1;
      change[base + row.index] = row.change;
      turnover[base + row.index] = row.turnover;
      rank[base + row.index] = row.rank;
      compositeRaw[base + row.index] = row.factors.composite ?? 0;
      if (row.change > 0) rising += 1;
    }
    validCount[frameIndex] = frame.rows.length;
    breadth[frameIndex] = frame.rows.length > 0 ? rising / frame.rows.length : 0.5;
    for (const factor of CONSTELLATION_FACTORS) {
      const ranked = softScores(frame.rows.map((row) => row.factors[factor]));
      frame.rows.forEach((row, position) => {
        factors[factor][base + row.index] = ranked[position] ?? 50;
      });
    }
  });

  const frameTimes = collected.map((frame) => frame.time);
  const step = frames?.stepHours ? frames.stepHours * 3_600_000 : 3_600_000;
  const gapAfter = frameTimes.slice(1).map((time, index) => time - frameTimes[index]! > step * 1.5);
  const sectors = [...new Set(categories)].sort((left, right) => radarSectorOrder(left) - radarSectorOrder(right));
  const partial = { instIds, categories, frameTimes, count, frames: frameCount, valid, factors, breadth };
  return {
    instIds,
    labels: instIds.map((instId) => instId.replace(/-USDT-SWAP$/, "")),
    categories,
    frameTimes,
    gapAfter,
    liveIndex,
    count,
    frames: frameCount,
    valid,
    factors,
    change,
    turnover,
    rank,
    breadth,
    compositeRaw,
    validCount,
    sectors,
    events: detectEvents(partial, sectors)
  };
}

type EventInput = Pick<ConstellationModel, "instIds" | "categories" | "frameTimes" | "count" | "frames" | "valid" | "factors" | "breadth">;

// 事件只从数据里读：板块平均综合位置 24h 内显著上移 / 下移，或全市场上涨占比到达极值。
// 同一板块 48h 内只记一次，最多保留 8 个幅度最大的事件，时间轴上按时间排列。
function detectEvents(model: EventInput, sectors: string[]): ConstellationEvent[] {
  if (model.frames < 3) return [];
  const composite = model.factors.composite;
  const hour = 3_600_000;
  const found: ConstellationEvent[] = [];
  const members = new Map(sectors.map((sector) => [sector, model.categories.flatMap((category, index) => (category === sector ? [index] : []))]));
  const sectorMean = (sector: string, frame: number) => {
    let sum = 0;
    let n = 0;
    for (const index of members.get(sector) ?? []) {
      const key = frame * model.count + index;
      if (!model.valid[key]) continue;
      sum += composite[key]!;
      n += 1;
    }
    return n >= 4 ? sum / n : null;
  };
  const frameBefore = (frame: number, hours: number) => {
    const target = model.frameTimes[frame]! - hours * hour;
    let cursor = frame;
    while (cursor > 0 && model.frameTimes[cursor]! > target) cursor -= 1;
    return Math.abs(model.frameTimes[cursor]! - target) <= Math.max(3, hours / 4) * hour ? cursor : null;
  };
  for (const sector of sectors) {
    if (sector === "other") continue;
    let lastAt = -Infinity;
    for (let frame = 1; frame < model.frames; frame += 1) {
      const time = model.frameTimes[frame]!;
      if (time - lastAt < 48 * hour) continue;
      const back = frameBefore(frame, 24);
      if (back === null) continue;
      const now = sectorMean(sector, frame);
      const before = sectorMean(sector, back);
      if (now === null || before === null) continue;
      const delta = now - before;
      if (Math.abs(delta) < 6) continue;
      found.push({ frame, time, kind: delta > 0 ? "sector-up" : "sector-down", sector, value: delta });
      lastAt = time;
    }
  }
  let lastBreadth = -Infinity;
  for (let frame = 0; frame < model.frames; frame += 1) {
    const time = model.frameTimes[frame]!;
    const value = model.breadth[frame]!;
    if (time - lastBreadth < 72 * hour || (value > 0.25 && value < 0.75)) continue;
    found.push({ frame, time, kind: value >= 0.75 ? "breadth-up" : "breadth-down", sector: null, value });
    lastBreadth = time;
  }
  const magnitude = (event: ConstellationEvent) => (event.sector ? Math.abs(event.value) / 6 : Math.abs(event.value - 0.5) * 6);
  return found.sort((left, right) => magnitude(right) - magnitude(left)).slice(0, 8).sort((left, right) => left.time - right.time);
}

/** 某合约在 frame 与 frame 之前约 hours 小时两帧之间的名次变化（正数 = 上升）；任一帧缺失返回 null。 */
export function rankChangeOver(model: ConstellationModel, index: number, frame: number, hours: number): number | null {
  const time = model.frameTimes[frame];
  if (time === undefined || !model.valid[frame * model.count + index]) return null;
  const target = time - hours * 3_600_000;
  let back = frame;
  while (back > 0 && model.frameTimes[back]! > target + 30 * 60_000) back -= 1;
  if (back === frame || Math.abs(model.frameTimes[back]! - target) > 90 * 60_000 * Math.max(1, hours / 24)) return null;
  if (!model.valid[back * model.count + index]) return null;
  return model.rank[back * model.count + index]! - model.rank[frame * model.count + index]!;
}
