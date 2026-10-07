/**
 * Profile 配置页的拖动条与步进器刻度。
 *
 * 拖动条不是均匀刻度，而是按「常用值」一档一档走：小数值分得更细（0.25% 和 0.5% 之间也能拖准），
 * 大数值稀一些。刻度下方标出的几档可以直接点选。输入框仍可填常用值以外的任意数（在合法范围内），
 * 这时拖动条按相邻两档插值摆放。
 */

export type NiceScale = {
  /** 拖动条依次停靠的值（严格递增）。 */
  values: readonly number[];
  /** 刻度下方可直接点选的几档（必须出现在 `values` 里）。 */
  ticks: readonly number[];
};

export const PROFILE_SCALES = {
  maxSingleTradeMarginPct: { values: [1, 2, 3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100], ticks: [10, 25, 50, 100] },
  // 单笔风险与日亏停止线只按权益封顶（100%），拖动条一直走到 100%。
  riskPerTradePct: {
    values: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 100],
    ticks: [0.5, 1, 2, 5, 10, 100]
  },
  dailyLossLimitPct: { values: [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100], ticks: [2, 5, 10, 20, 50, 100] },
  minRewardRisk: { values: [0.5, 0.8, 1, 1.2, 1.5, 1.8, 2, 2.5, 3, 4, 5], ticks: [1, 1.5, 2, 3, 5] },
  maxEntryDriftBps: { values: [1, 2, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300], ticks: [10, 30, 100, 300] }
} as const satisfies Record<string, NiceScale>;

/** 离散参数的快选按钮。 */
export const PROFILE_PRESETS = {
  targetLeverage: [3, 5, 10, 20, 50],
  maxOpenPositions: [1, 2, 3, 5]
} as const;

/** 步进器（−/+）依次经过的常用值。 */
export const PROFILE_STEPS = {
  scanIntervalMinutes: [1, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440],
  minWakeIntervalSeconds: [30, 60, 90, 120, 180, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400],
  maxRunsPerHour: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 45, 60],
  historyLookbackDays: [1, 3, 7, 14, 30, 60, 90, 180, 365],
  similarityWindowMinutes: [1, 5, 10, 15, 30, 60, 120, 240, 720, 1440],
  entryToleranceBps: [1, 5, 10, 20, 30, 50, 100, 200, 500, 1000, 2000]
} as const;

/** 值在拖动条上的位置（0 … values.length - 1，可为小数）。超出两端时贴边。 */
export function scalePosition(values: readonly number[], value: number): number {
  if (values.length === 0 || !Number.isFinite(value)) return 0;
  if (value <= values[0]) return 0;
  for (let index = 1; index < values.length; index += 1) {
    if (value <= values[index]) return index - 1 + (value - values[index - 1]) / (values[index] - values[index - 1]);
  }
  return values.length - 1;
}

/** 拖动条位置 → 停靠的常用值（四舍五入到最近一档）。 */
export function scaleValueAt(values: readonly number[], position: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.round(Number.isFinite(position) ? position : 0)));
  return values[index];
}

/**
 * 步进器的下一档：`+1` 取严格大于当前值的最小常用值，`-1` 取严格小于当前值的最大常用值；
 * 已在两端时原样返回。当前值不在列表里也能正确走到相邻一档。
 */
export function stepValue(values: readonly number[], value: number, direction: 1 | -1): number {
  if (values.length === 0) return value;
  if (direction > 0) return values.find((item) => item > value + 1e-9) ?? value;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] < value - 1e-9) return values[index];
  }
  return value;
}
