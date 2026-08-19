import type { Candle } from "../types";

export type ChartSeriesKey = {
  symbol: string;
  timeframe: string;
};

export type ChartHistoryCursor = {
  beforeTime: number | null;
  exhausted: boolean;
};

export type HistoricalCandlesPage = {
  candles: Candle[];
  earliestTime?: number | null;
  exhausted: boolean;
  source?: "local" | "history" | "mixed";
};

type ChartDataPatchBase = {
  key: ChartSeriesKey;
  cursor: ChartHistoryCursor;
};

export type ChartDataPatch =
  | (ChartDataPatchBase & { type: "reset"; candles: Candle[] })
  | (ChartDataPatchBase & { type: "append"; candles: Candle[] })
  | (ChartDataPatchBase & { type: "updateLatest"; candle: Candle })
  | (ChartDataPatchBase & { type: "prepend"; candles: Candle[] })
  | (ChartDataPatchBase & { type: "noChange" });

export type CandleIndexState = {
  map: Map<number, Candle>;
  index: Map<number, number>;
};

export function updateCandleIndexes(current: CandleIndexState, canonicalCandles: readonly Candle[], patch: ChartDataPatch): CandleIndexState {
  const canPatchCandleIndexes = patch.type === "append"
    && current.index.size + patch.candles.length === canonicalCandles.length;
  if (canPatchCandleIndexes) {
    const firstNewIndex = canonicalCandles.length - patch.candles.length;
    for (let index = firstNewIndex; index < canonicalCandles.length; index += 1) {
      const candle = canonicalCandles[index];
      current.map.set(candle.time, candle);
      current.index.set(candle.time, index);
    }
    return current;
  }

  if (patch.type === "updateLatest" && current.index.size === canonicalCandles.length) {
    const latestIndex = canonicalCandles.length - 1;
    const candle = canonicalCandles[latestIndex];
    current.map.set(candle.time, candle);
    current.index.set(candle.time, latestIndex);
    return current;
  }

  if (patch.type === "noChange" && current.index.size === canonicalCandles.length) return current;
  return {
    map: new Map(canonicalCandles.map((candle) => [candle.time, candle])),
    index: new Map(canonicalCandles.map((candle, index) => [candle.time, index]))
  };
}

type ChartSeriesState = {
  candles: Candle[];
  exhausted: boolean;
};

/** Maintains canonical candle series and emits the smallest render patch. */
export class ChartDataController {
  private readonly series = new Map<string, ChartSeriesState>();

  getCandles(key: ChartSeriesKey): readonly Candle[] {
    return this.series.get(toSeriesId(key))?.candles ?? [];
  }

  getHistoryCursor(key: ChartSeriesKey): ChartHistoryCursor {
    return this.cursorFor(this.series.get(toSeriesId(key)));
  }

  replaceSnapshot(key: ChartSeriesKey, candles: readonly Candle[], exhausted = false): ChartDataPatch {
    const state: ChartSeriesState = { candles: normalizeCandles(candles), exhausted };
    this.series.set(toSeriesId(key), state);
    return { type: "reset", key, candles: state.candles, cursor: this.cursorFor(state) };
  }

  ingestRealtime(key: ChartSeriesKey, incoming: Candle | readonly Candle[]): ChartDataPatch {
    const nextCandles = normalizeCandles(Array.isArray(incoming) ? incoming : [incoming]);
    const id = toSeriesId(key);
    const state = this.series.get(id);
    if (!state) return this.replaceSnapshot(key, nextCandles);
    if (nextCandles.length === 0) return this.noChange(key, state);

    const current = state.candles;
    if (current.length === 0) {
      state.candles = nextCandles;
      return { type: "reset", key, candles: state.candles, cursor: this.cursorFor(state) };
    }

    const currentByTime = new Map(current.map((candle) => [candle.time, candle]));
    const additions = nextCandles.filter((candle) => !currentByTime.has(candle.time));
    const changes = nextCandles.filter((candle) => {
      const existing = currentByTime.get(candle.time);
      return existing !== undefined && !sameCandle(existing, candle);
    });
    if (additions.length === 0 && changes.length === 0) return this.noChange(key, state);

    const firstTime = current[0].time;
    const lastTime = current[current.length - 1].time;
    const hasOlderAdditions = additions.some((candle) => candle.time < firstTime);
    const hasInteriorChanges = changes.some((candle) => candle.time < lastTime);

    if (hasInteriorChanges || (hasOlderAdditions && (changes.length > 0 || additions.some((candle) => candle.time >= firstTime)))) {
      state.candles = mergeCandles(current, nextCandles);
      return { type: "reset", key, candles: state.candles, cursor: this.cursorFor(state) };
    }

    if (hasOlderAdditions) {
      const prepended = additions.filter((candle) => candle.time < firstTime);
      state.candles = mergeCandles(current, prepended);
      return { type: "prepend", key, candles: prepended, cursor: this.cursorFor(state) };
    }

    if (changes.length === 1 && changes[0].time === lastTime && additions.length === 0) {
      const candle = changes[0];
      state.candles = [...current.slice(0, -1), candle];
      return { type: "updateLatest", key, candle, cursor: this.cursorFor(state) };
    }

    if (changes.length === 0 && additions.every((candle) => candle.time > lastTime)) {
      state.candles = [...current, ...additions];
      return { type: "append", key, candles: additions, cursor: this.cursorFor(state) };
    }

    state.candles = mergeCandles(current, nextCandles);
    return { type: "reset", key, candles: state.candles, cursor: this.cursorFor(state) };
  }

  applyHistoricalPage(key: ChartSeriesKey, page: HistoricalCandlesPage): ChartDataPatch {
    const id = toSeriesId(key);
    const state = this.series.get(id) ?? { candles: [], exhausted: false };
    const historical = normalizeCandles(page.candles);
    const current = state.candles;
    const currentByTime = new Map(current.map((candle) => [candle.time, candle]));
    const beforeFirst = current.length === 0 ? historical : historical.filter((candle) => candle.time < current[0].time);
    const requiresReset = current.length > 0 && historical.some((candle) => {
      if (candle.time < current[0].time) return false;
      const existing = currentByTime.get(candle.time);
      return existing === undefined || !sameCandle(existing, candle);
    });
    state.exhausted = state.exhausted || page.exhausted;

    if (current.length === 0) {
      state.candles = historical;
      this.series.set(id, state);
      return { type: "reset", key, candles: state.candles, cursor: this.cursorFor(state) };
    }
    if (requiresReset) {
      state.candles = mergeCandles(current, historical);
      this.series.set(id, state);
      return { type: "reset", key, candles: state.candles, cursor: this.cursorFor(state) };
    }
    if (beforeFirst.length > 0) {
      state.candles = [...beforeFirst, ...current];
      this.series.set(id, state);
      return { type: "prepend", key, candles: beforeFirst, cursor: this.cursorFor(state) };
    }
    this.series.set(id, state);
    return this.noChange(key, state);
  }

  markHistoryExhausted(key: ChartSeriesKey): ChartHistoryCursor {
    const id = toSeriesId(key);
    const state = this.series.get(id) ?? { candles: [], exhausted: false };
    state.exhausted = true;
    this.series.set(id, state);
    return this.cursorFor(state);
  }

  clear(key: ChartSeriesKey): void {
    this.series.delete(toSeriesId(key));
  }

  clearAll(): void {
    this.series.clear();
  }

  private noChange(key: ChartSeriesKey, state: ChartSeriesState): ChartDataPatch {
    return { type: "noChange", key, cursor: this.cursorFor(state) };
  }

  private cursorFor(state?: ChartSeriesState): ChartHistoryCursor {
    return { beforeTime: state?.candles[0]?.time ?? null, exhausted: state?.exhausted ?? false };
  }
}

export function chartSeriesId(key: ChartSeriesKey): string {
  return toSeriesId(key);
}

function toSeriesId({ symbol, timeframe }: ChartSeriesKey): string {
  return `${symbol}\u0000${timeframe}`;
}

function normalizeCandles(candles: readonly Candle[]): Candle[] {
  if (candles.length === 0) return [];

  // REST pages and the normal realtime path are already canonical. Avoid
  // allocating a Map and sorting the full series unless input is irregular.
  let previousTime = Number.NEGATIVE_INFINITY;
  let canonical = true;
  for (const candle of candles) {
    if (!isValidCandle(candle) || candle.time <= previousTime) {
      canonical = false;
      break;
    }
    previousTime = candle.time;
  }
  if (canonical) return [...candles];

  const byTime = new Map<number, Candle>();
  for (const candle of candles) {
    if (!isValidCandle(candle)) continue;
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function mergeCandles(current: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  return normalizeCandles([...current, ...incoming]);
}

function sameCandle(left: Candle, right: Candle): boolean {
  return left.time === right.time && left.open === right.open && left.high === right.high && left.low === right.low
    && left.close === right.close && left.volume === right.volume && left.confirm === right.confirm;
}

function isValidCandle(candle: Candle): boolean {
  return Number.isFinite(candle.time) && Number.isFinite(candle.open) && Number.isFinite(candle.high)
    && Number.isFinite(candle.low) && Number.isFinite(candle.close) && Number.isFinite(candle.volume);
}
