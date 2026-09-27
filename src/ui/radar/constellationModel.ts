import type { MarketRadarResearchScore, MarketRadarSnapshotFrames } from "../../types";
import type { MarketRadarRow } from "../../lib/marketRadar";
import { buildRadarSnapshotInput } from "../../lib/marketRadarSnapshot";

// 星图数据模型：把后端列式快照帧 + 当前实时行统一成稠密数组。
// 坐标轴因子在每一帧内取百分位（0–100）：存储的是加权分，量纲随模型版本变化，百分位只保留相对位置。

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
  /** 24h 涨跌，单位 %。 */
  change: Float32Array;
  turnover: Float32Array;
  rank: Float32Array;
  /** 每帧的上涨占比（市场宽度），用于时间轴背景曲线。 */
  breadth: Float32Array;
};

type FrameValues = {
  time: number;
  rows: Array<{ index: number; rank: number; factors: Record<ConstellationFactor, number | null>; change: number; turnover: number }>;
};

function percentiles(values: Array<number | null>): Array<number | null> {
  const indexed = values.map((value, index) => ({ value, index })).filter((entry): entry is { value: number; index: number } => entry.value !== null && Number.isFinite(entry.value));
  indexed.sort((left, right) => left.value - right.value);
  const out: Array<number | null> = values.map(() => null);
  const last = Math.max(indexed.length - 1, 1);
  let start = 0;
  // 并列值取同一平均名次，避免同分合约在坐标轴上被人为拉开。
  while (start < indexed.length) {
    let end = start;
    while (end + 1 < indexed.length && indexed[end + 1]!.value === indexed[start]!.value) end += 1;
    const position = ((start + end) / 2 / last) * 100;
    for (let cursor = start; cursor <= end; cursor += 1) out[indexed[cursor]!.index] = position;
    start = end + 1;
  }
  return out;
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
    categories.push(category || "other");
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
      if (row.change > 0) rising += 1;
    }
    breadth[frameIndex] = frame.rows.length > 0 ? rising / frame.rows.length : 0.5;
    for (const factor of CONSTELLATION_FACTORS) {
      const ranked = percentiles(frame.rows.map((row) => row.factors[factor]));
      frame.rows.forEach((row, position) => {
        factors[factor][base + row.index] = ranked[position] ?? 50;
      });
    }
  });

  const frameTimes = collected.map((frame) => frame.time);
  const step = frames?.stepHours ? frames.stepHours * 3_600_000 : 3_600_000;
  const gapAfter = frameTimes.slice(1).map((time, index) => time - frameTimes[index]! > step * 1.5);
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
    breadth
  };
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
