import type { ChartCandlePoint } from "../ui/chartAdapter";

// AI 工具返回的 K 线解析（market.readCandles 单 / 多周期、OKX REST 数组行、稀疏收盘价序列）。
// 研究检查器与证据板共用同一份解析，保证同一工具结果在两处画出同一条序列。

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseRecord(value: unknown) {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function numberValue(value: unknown, ...keys: string[]) {
  const source = record(value);
  for (const key of keys) {
    const raw = source[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const next = typeof raw === "number" ? raw : Number(String(raw).replaceAll(",", ""));
    if (Number.isFinite(next)) return next;
  }
  return null;
}

function payloadSources(data: unknown) {
  const source = parseRecord(data);
  const result = parseRecord(source.result);
  return { source, result, nested: parseRecord(result.result) };
}

export type ParsedCandleSeries = {
  candles: ChartCandlePoint[];
  // 是否每个点都带真实 OHLC；false 表示仅收盘价可用（稀疏序列，走"线 + 点标记"渲染）
  complete: boolean;
  // 命中的周期标签（如 "5m"），来自 bars 包装键或顶层 bar 字段
  bar: string | null;
};

function normalizeCandleTime(time: number) {
  return time < 10_000_000_000 ? time : Math.floor(time / 1000);
}

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const next = Number(value.replaceAll(",", ""));
    return Number.isFinite(next) ? next : null;
  }
  return null;
}

// 实际工具返回形状（对照 src-tauri/src/lib.rs 的 ai_read_candles / ai_read_multi_candles）：
// - 单周期调用：{ instId, bar, candles: [{ time(13 位 ms), openTimeMs, closeTimeMs, open, high, low, close, volume, confirm }] }
// - 多周期调用：{ summary: "… 已读取 N 个周期 K 线", instId, bars: { "5m": { candles: […] }, "15m": {…}, … } }
//   多周期返回的 candles 嵌在 bars.<周期> 之下，顶层没有任何候选键——旧实现只找顶层
//   candles/history/series/items，因此解析得 0 点、图表落到"单点快照"兜底，而卡片描述仍写
//   "已读取 3 个周期"，观感自相矛盾（3 指的是 3 个周期/时间框架，不是 3 根 K 线）。
//   这里做防御性多形状解析：bars 包装、OKX REST 数组行 [ts, o, h, l, c, vol]、
//   time/timestamp/ts 等键名、字符串数字，以及只有收盘价可用的稀疏行（{ time, value/close }）。
function parseCandleRow(item: unknown): { time: number; open: number | null; high: number | null; low: number | null; close: number | null } | null {
  if (Array.isArray(item)) {
    const cells = item.map(coerceFiniteNumber);
    if (cells.length >= 5 && cells[0] !== null) {
      return { time: cells[0]!, open: cells[1] ?? null, high: cells[2] ?? null, low: cells[3] ?? null, close: cells[4] ?? null };
    }
    return null;
  }
  const row = record(item);
  if (Object.keys(row).length === 0) return null;
  const time = numberValue(row, "time", "openTimeMs", "openTime", "timestamp", "ts");
  if (time === null) return null;
  return {
    time,
    open: numberValue(row, "open", "o", "openPx"),
    high: numberValue(row, "high", "h", "highPx"),
    low: numberValue(row, "low", "l", "lowPx"),
    close: numberValue(row, "close", "c", "closePx", "price", "value", "last")
  };
}

function collectCandlePoints(candidate: unknown): { candles: ChartCandlePoint[]; complete: boolean } {
  if (!Array.isArray(candidate)) return { candles: [], complete: false };
  const candles: ChartCandlePoint[] = [];
  let complete = true;
  for (const item of candidate) {
    const row = parseCandleRow(item);
    if (!row || row.close === null) {
      complete = false;
      continue;
    }
    const { time, close } = row;
    if (row.open === null || row.high === null || row.low === null) {
      // 缺 OHLC 的稀疏点：只保留收盘价，按平值占位，由图表层降级为"线 + 点标记"
      complete = false;
      candles.push({ time: normalizeCandleTime(time), open: close, high: close, low: close, close });
      continue;
    }
    candles.push({ time: normalizeCandleTime(time), open: row.open, high: row.high, low: row.low, close });
  }
  const unique = new Map(candles.map((value): [number, ChartCandlePoint] => [value.time, value]));
  return { candles: [...unique.values()].sort((left, right) => left.time - right.time), complete };
}

export function parseMarketCandles(data: unknown): ParsedCandleSeries {
  const { source, result, nested } = payloadSources(data);
  // best：≥2 点的真实序列；single：仅 1 点的单点快照（保底同源展示，避免图表与计数各说各话）
  let best: ParsedCandleSeries | null = null;
  let single: ParsedCandleSeries | null = null;
  // 1) 多周期包装：bars.<bar> 下挂 candles（或直接是数组 / 再包一层 data/list）
  for (const root of [source, result, nested]) {
    for (const [bar, group] of Object.entries(record(root.bars))) {
      const groupRecord = record(group);
      const candidates = [groupRecord.candles, groupRecord.data, groupRecord.list, Array.isArray(group) ? group : null];
      for (const candidate of candidates) {
        const parsed = collectCandlePoints(candidate);
        // 多周期返回含多组序列：一张图画同一条周期序列才诚实——取样本最多的一组，
        // 其余周期组保留在"原始数据"里可查
        if (parsed.candles.length >= 2 && (!best || parsed.candles.length > best.candles.length)) {
          best = { ...parsed, bar };
        }
        if (parsed.candles.length === 1 && !single) {
          single = { ...parsed, bar };
        }
      }
    }
  }
  if (best) return best;
  // 2) 顶层别名键（旧单周期形状与第三方包装）
  for (const root of [source, result, nested]) {
    for (const key of ["candles", "history", "series", "items", "data", "list"]) {
      const parsed = collectCandlePoints(root[key]);
      if (parsed.candles.length >= 2) return { ...parsed, bar: text(root.bar) || null };
      if (parsed.candles.length === 1 && !single) {
        single = { ...parsed, bar: text(root.bar) || null };
      }
    }
  }
  if (single) return single;
  return { candles: [], complete: true, bar: text(source.bar) || text(result.bar) || null };
}
