import type { MarketRadarResearchScore } from "../types";
import type { MarketRadarRow } from "./marketRadar";
import type { recordMarketRadarSnapshot } from "./okx";

type SnapshotInput = Parameters<typeof recordMarketRadarSnapshot>[0];

// 把雷达排行行转换为每小时快照的写入载荷。权重与综合评分模型一致：
// 研究历史就绪时按日线研究分 + 快照分加权，未就绪时只用快照分。
export function buildRadarSnapshotInput(rows: MarketRadarRow[], researchScores: MarketRadarResearchScore[], fetchedAt: number): SnapshotInput {
  return {
    fetchedAt,
    modelVersion: `market-radar-composite-v1:${researchScores[0]?.modelVersion ?? "snapshot-v1"}`,
    rows: rows.map((row) => ({
      instId: row.instrument.instId,
      category: row.instrument.instCategory,
      listTime: Number(row.instrument.listTime || 0) || undefined,
      rank: row.rank,
      compositeScore: row.compositeScore,
      strengthScore: row.research
        ? row.research.strengthScore * 0.315 + row.strengthScore * 0.12
        : row.strengthScore * 0.40,
      lowVolatilityScore: row.research ? row.research.lowVolatilityScore * 0.14 : 0,
      activityScore: row.research
        ? row.research.activityScore * 0.14 + row.activityScore * 0.105
        : row.activityScore * 0.35,
      rawActivityScore: row.research?.activityScore ?? row.activityScore,
      trendQualityScore: row.research ? row.research.trendQualityScore * 0.105 : 0,
      rawTrendQualityScore: row.research?.trendQualityScore,
      volatility20dPct: row.research?.volatility20dPct,
      liquidityScore: row.liquidityScore * (row.research ? 0.075 : 0.25),
      change24hPct: row.change24hPct,
      turnover24h: row.turnover24h,
      lastPrice: row.last,
      spreadBps: row.spreadBps ?? undefined,
      historyReady: Boolean(row.research),
    })),
  };
}

export function radarAlertMessage(alert: { kind: string; instId: string; currentValue: number; threshold: number }, chinese: boolean) {
  const labels: Record<string, [string, string]> = {
    enterTop: [`${alert.instId} 首次进入 Top ${alert.threshold}`, `${alert.instId} entered Top ${alert.threshold}`],
    rankRise: [`${alert.instId} 一小时上升 ${alert.currentValue.toFixed(0)} 名`, `${alert.instId} rose ${alert.currentValue.toFixed(0)} ranks in one hour`],
    activityAbove: [`${alert.instId} 活跃度升至 ${alert.currentValue.toFixed(0)}`, `${alert.instId} activity rose to ${alert.currentValue.toFixed(0)}`],
    spreadAbove: [`${alert.instId} 点差扩大至 ${alert.currentValue.toFixed(1)} bp`, `${alert.instId} spread widened to ${alert.currentValue.toFixed(1)} bp`],
    newListing: [`发现新标的 ${alert.instId}`, `New market detected: ${alert.instId}`],
    historyReady: [`${alert.instId} 研究历史已就绪`, `${alert.instId} research history is ready`],
  };
  return (labels[alert.kind] ?? [alert.instId, alert.instId])[chinese ? 0 : 1];
}
