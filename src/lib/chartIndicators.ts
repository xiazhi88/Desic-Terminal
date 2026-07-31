/**
 * Pure chart indicator definitions and calculators. This module intentionally
 * has no chart-library or React dependency so it can be shared by chart panes,
 * replay, and worker-based calculation paths.
 */

export type ChartCandle = Readonly<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;

export type IndicatorId =
  | "ma"
  | "ema"
  | "vwap"
  | "boll"
  | "donchian"
  | "keltner"
  | "psar"
  | "supertrend"
  | "ichimoku"
  | "rsi"
  | "macd"
  | "kdj"
  | "atr"
  | "adx"
  | "stochastic"
  | "cci"
  | "roc"
  | "aroon"
  | "trix"
  | "williams-r"
  | "mfi"
  | "cmf"
  | "obv"
  | "volume-ma";

export type IndicatorPane = "main" | "sub";
export type IndicatorValue = number | string | boolean;
export type IndicatorParameters = Readonly<Record<string, IndicatorValue>>;

export type IndicatorParameterDefinition = Readonly<{
  key: string;
  label: string;
  type: "integer" | "number";
  defaultValue: number;
  min?: number;
  max?: number;
}>;

export type IndicatorDefinition = Readonly<{
  id: IndicatorId;
  name: string;
  description: string;
  pane: IndicatorPane;
  parameters: readonly IndicatorParameterDefinition[];
  outputKeys: readonly string[];
}>;

export type IndicatorInstance = Readonly<{
  id: string;
  definitionId: IndicatorId;
  paneId: string;
  visible: boolean;
  parameters?: IndicatorParameters;
}>;

export type ChartPaneLayout = Readonly<{
  id: string;
  kind: "main" | "indicator";
  height?: number;
  indicatorIds: readonly string[];
}>;

export type IndicatorPoint = Readonly<{ time: number; value: number }>;
export type IndicatorSeries = Readonly<{
  key: string;
  label: string;
  points: readonly IndicatorPoint[];
}>;

export type IndicatorResult = Readonly<{
  status: "ready" | "unavailable" | "invalid";
  series: readonly IndicatorSeries[];
  message?: string;
}>;

export type IndicatorInput = Readonly<{
  candles: readonly ChartCandle[];
}>;

export type IndicatorDataPatch =
  | Readonly<{ type: "reset"; candles: readonly ChartCandle[] }>
  | Readonly<{ type: "append"; candles: readonly ChartCandle[] }>
  | Readonly<{ type: "updateLatest"; candle: ChartCandle }>
  | Readonly<{ type: "prepend"; candles: readonly ChartCandle[] }>
  | Readonly<{ type: "noChange" }>;

export type IndicatorCalculator = Readonly<{
  reset(input: IndicatorInput): IndicatorResult;
  applyPatch(patch: IndicatorDataPatch): IndicatorResult;
  getInput(): IndicatorInput;
  getResult(): IndicatorResult;
}>;

const parameter = (key: string, label: string, defaultValue: number, min: number, max = 100_000): IndicatorParameterDefinition => ({
  key,
  label,
  type: Number.isInteger(defaultValue) ? "integer" : "number",
  defaultValue,
  min,
  max,
});

export const INDICATOR_DEFINITIONS: Readonly<Record<IndicatorId, IndicatorDefinition>> = {
  ma: { id: "ma", name: "MA", description: "简单移动平均线，平滑价格波动，用于观察基础趋势和动态支撑阻力。", pane: "main", parameters: [parameter("period", "Period", 20, 1)], outputKeys: ["ma"] },
  ema: { id: "ema", name: "EMA", description: "指数移动平均线，对最新价格反应更快，常用于短线趋势和交叉信号。", pane: "main", parameters: [parameter("period", "Period", 20, 1)], outputKeys: ["ema"] },
  vwap: { id: "vwap", name: "VWAP", description: "成交量加权平均价，衡量当期市场平均成交成本。", pane: "main", parameters: [], outputKeys: ["vwap"] },
  boll: {
    id: "boll",
    name: "Bollinger Bands",
    description: "布林带用均线和标准差构造上下轨，辅助判断波动扩张、收缩和价格偏离。",
    pane: "main",
    parameters: [parameter("period", "Period", 20, 2), parameter("multiplier", "Multiplier", 2, 0.01, 100)],
    outputKeys: ["middle", "upper", "lower"],
  },
  donchian: {
    id: "donchian",
    name: "Donchian Channel",
    description: "唐奇安通道显示指定周期最高价和最低价，常用于突破和趋势跟随。",
    pane: "main",
    parameters: [parameter("period", "Period", 20, 2)],
    outputKeys: ["upper", "middle", "lower"],
  },
  keltner: {
    id: "keltner",
    name: "Keltner Channel",
    description: "肯特纳通道以 EMA 和 ATR 构造价格通道，适合观察趋势中的波动边界。",
    pane: "main",
    parameters: [parameter("period", "EMA period", 20, 1), parameter("atrPeriod", "ATR period", 10, 1), parameter("multiplier", "Multiplier", 2, 0.01, 100)],
    outputKeys: ["middle", "upper", "lower"],
  },
  psar: {
    id: "psar",
    name: "Parabolic SAR",
    description: "抛物线 SAR 用点位跟踪趋势方向，常用于趋势止损和反转提示。",
    pane: "main",
    parameters: [parameter("step", "Step", 0.02, 0.001, 1), parameter("maxStep", "Max step", 0.2, 0.001, 2)],
    outputKeys: ["psar"],
  },
  supertrend: {
    id: "supertrend",
    name: "Supertrend",
    description: "Supertrend 基于 ATR 跟踪趋势方向，用于识别趋势延续和反转区域。",
    pane: "main",
    parameters: [parameter("period", "ATR period", 10, 1), parameter("multiplier", "Multiplier", 3, 0.01, 100)],
    outputKeys: ["supertrend"],
  },
  ichimoku: {
    id: "ichimoku",
    name: "Ichimoku",
    description: "一目均衡表综合转换线、基准线和云区，观察趋势、支撑阻力与动量。",
    pane: "main",
    parameters: [parameter("conversionPeriod", "Conversion", 9, 1), parameter("basePeriod", "Base", 26, 1), parameter("spanBPeriod", "Span B", 52, 1)],
    outputKeys: ["conversion", "base", "spanA", "spanB"],
  },
  rsi: { id: "rsi", name: "RSI", description: "相对强弱指数，衡量上涨和下跌动能，常用于超买超卖判断。", pane: "sub", parameters: [parameter("period", "Period", 14, 1)], outputKeys: ["rsi"] },
  macd: {
    id: "macd",
    name: "MACD",
    description: "MACD 使用快慢 EMA 差值和信号线，观察趋势动能变化和背离。",
    pane: "sub",
    parameters: [parameter("fast", "Fast", 12, 1), parameter("slow", "Slow", 26, 2), parameter("signal", "Signal", 9, 1)],
    outputKeys: ["macd", "signal", "histogram"],
  },
  kdj: {
    id: "kdj",
    name: "KDJ",
    description: "KDJ 基于随机指标扩展 J 线，反应灵敏，常用于短线拐点观察。",
    pane: "sub",
    parameters: [parameter("period", "Period", 9, 1), parameter("kPeriod", "K smoothing", 3, 1), parameter("dPeriod", "D smoothing", 3, 1)],
    outputKeys: ["k", "d", "j"],
  },
  atr: { id: "atr", name: "ATR", description: "平均真实波幅，衡量市场波动强度，常用于止损距离和仓位风险估算。", pane: "sub", parameters: [parameter("period", "Period", 14, 1)], outputKeys: ["atr"] },
  adx: { id: "adx", name: "ADX / DMI", description: "ADX 衡量趋势强度，+DI 和 -DI 用于比较多空方向力量。", pane: "sub", parameters: [parameter("period", "Period", 14, 1)], outputKeys: ["adx", "plusDi", "minusDi"] },
  stochastic: {
    id: "stochastic",
    name: "Stochastic",
    description: "随机指标比较收盘价在近期高低区间中的位置，用于超买超卖和动量拐点。",
    pane: "sub",
    parameters: [parameter("period", "Period", 14, 1), parameter("kSmoothing", "K smoothing", 3, 1), parameter("dPeriod", "D smoothing", 3, 1)],
    outputKeys: ["k", "d"],
  },
  cci: { id: "cci", name: "CCI", description: "顺势指标衡量价格偏离典型均值的程度，常用于趋势强弱和极端偏离。", pane: "sub", parameters: [parameter("period", "Period", 20, 1)], outputKeys: ["cci"] },
  roc: { id: "roc", name: "ROC", description: "变化率指标计算当前价格相对过去价格的百分比变化，观察动量速度。", pane: "sub", parameters: [parameter("period", "Period", 12, 1)], outputKeys: ["roc"] },
  aroon: { id: "aroon", name: "Aroon", description: "Aroon 统计近期高低点距离当前的时间，辅助判断趋势启动和衰减。", pane: "sub", parameters: [parameter("period", "Period", 14, 2)], outputKeys: ["up", "down"] },
  trix: {
    id: "trix",
    name: "TRIX",
    description: "TRIX 是三重平滑 EMA 的变化率，过滤噪音后观察中期动量。",
    pane: "sub",
    parameters: [parameter("period", "Period", 15, 1), parameter("signal", "Signal", 9, 1)],
    outputKeys: ["trix", "signal"],
  },
  "williams-r": { id: "williams-r", name: "Williams %R", description: "威廉指标衡量收盘价接近近期高低区间的位置，常用于超买超卖判断。", pane: "sub", parameters: [parameter("period", "Period", 14, 1)], outputKeys: ["williamsR"] },
  mfi: { id: "mfi", name: "MFI", description: "资金流量指标结合价格和成交量，观察资金流入流出与超买超卖。", pane: "sub", parameters: [parameter("period", "Period", 14, 1)], outputKeys: ["mfi"] },
  cmf: { id: "cmf", name: "Chaikin Money Flow", description: "蔡金资金流量衡量一段时间内资金累积或派发压力。", pane: "sub", parameters: [parameter("period", "Period", 20, 1)], outputKeys: ["cmf"] },
  obv: { id: "obv", name: "OBV", description: "能量潮将成交量按涨跌方向累计，用于观察量价确认和背离。", pane: "sub", parameters: [], outputKeys: ["obv"] },
  "volume-ma": { id: "volume-ma", name: "Volume MA", description: "成交量均线平滑成交量变化，辅助识别放量、缩量和异常活跃。", pane: "sub", parameters: [parameter("period", "Period", 20, 1)], outputKeys: ["volume", "ma"] },
};

export const BUILT_IN_INDICATORS: readonly IndicatorDefinition[] = Object.values(INDICATOR_DEFINITIONS);

export function getIndicatorDefinition(id: IndicatorId): IndicatorDefinition {
  return INDICATOR_DEFINITIONS[id];
}

export function validateIndicatorParameters(definition: IndicatorDefinition, supplied?: IndicatorParameters):
  | Readonly<{ ok: true; value: Readonly<Record<string, number>> }>
  | Readonly<{ ok: false; message: string }> {
  const values: Record<string, number> = {};
  for (const parameterDefinition of definition.parameters) {
    const candidate = supplied?.[parameterDefinition.key] ?? parameterDefinition.defaultValue;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      return { ok: false, message: `${definition.name}: ${parameterDefinition.key} must be a finite number.` };
    }
    if (parameterDefinition.type === "integer" && !Number.isInteger(candidate)) {
      return { ok: false, message: `${definition.name}: ${parameterDefinition.key} must be an integer.` };
    }
    if (parameterDefinition.min !== undefined && candidate < parameterDefinition.min) {
      return { ok: false, message: `${definition.name}: ${parameterDefinition.key} must be at least ${parameterDefinition.min}.` };
    }
    if (parameterDefinition.max !== undefined && candidate > parameterDefinition.max) {
      return { ok: false, message: `${definition.name}: ${parameterDefinition.key} must be at most ${parameterDefinition.max}.` };
    }
    values[parameterDefinition.key] = candidate;
  }
  return { ok: true, value: values };
}

export function calculateIndicator(instance: IndicatorInstance, input: IndicatorInput): IndicatorResult {
  const definition = INDICATOR_DEFINITIONS[instance.definitionId];
  const parameters = validateIndicatorParameters(definition, instance.parameters);
  if (!parameters.ok) return { status: "invalid", series: [], message: parameters.message };
  if (definition.id === "macd" && parameters.value.fast >= parameters.value.slow) {
    return { status: "invalid", series: [], message: "MACD: fast must be less than slow." };
  }
  if (definition.id === "ichimoku" && (
    parameters.value.conversionPeriod > parameters.value.basePeriod
    || parameters.value.basePeriod > parameters.value.spanBPeriod
  )) {
    return { status: "invalid", series: [], message: "Ichimoku: conversion must be less than or equal to base, which must be less than or equal to Span B." };
  }
  if (definition.id === "psar" && parameters.value.step > parameters.value.maxStep) {
    return { status: "invalid", series: [], message: "Parabolic SAR: step must be less than or equal to max step." };
  }

  const candles = normalizeCandles(input.candles);
  const values = parameters.value;
  switch (definition.id) {
    case "ma": return ready(series("ma", "MA", simpleMovingAverage(candles, values.period, (candle) => candle.close)));
    case "ema": return ready(series("ema", "EMA", exponentialMovingAverage(candles, values.period, (candle) => candle.close)));
    case "vwap": return ready(series("vwap", "VWAP", vwap(candles)));
    case "boll": return ready(...bollinger(candles, values.period, values.multiplier));
    case "donchian": return ready(...donchian(candles, values.period));
    case "keltner": return ready(...keltner(candles, values.period, values.atrPeriod, values.multiplier));
    case "psar": return ready(series("psar", "SAR", parabolicSar(candles, values.step, values.maxStep)));
    case "supertrend": return ready(series("supertrend", "Supertrend", supertrend(candles, values.period, values.multiplier)));
    case "ichimoku": return ready(...ichimoku(candles, values.conversionPeriod, values.basePeriod, values.spanBPeriod));
    case "rsi": return ready(series("rsi", "RSI", rsi(candles, values.period)));
    case "macd": return ready(...macd(candles, values.fast, values.slow, values.signal));
    case "kdj": return ready(...kdj(candles, values.period, values.kPeriod, values.dPeriod));
    case "atr": return ready(series("atr", "ATR", atr(candles, values.period)));
    case "adx": return ready(...adxDmi(candles, values.period));
    case "stochastic": return ready(...stochastic(candles, values.period, values.kSmoothing, values.dPeriod));
    case "cci": return ready(series("cci", "CCI", cci(candles, values.period)));
    case "roc": return ready(series("roc", "ROC", roc(candles, values.period)));
    case "aroon": return ready(...aroon(candles, values.period));
    case "trix": return ready(...trix(candles, values.period, values.signal));
    case "williams-r": return ready(series("williamsR", "Williams %R", williamsR(candles, values.period)));
    case "mfi": return ready(series("mfi", "MFI", mfi(candles, values.period)));
    case "cmf": return ready(series("cmf", "CMF", chaikinMoneyFlow(candles, values.period)));
    case "obv": return ready(series("obv", "OBV", obv(candles)));
    case "volume-ma": return ready(
      series("volume", "Volume", candles.map((candle) => ({ time: candle.time, value: candle.volume }))),
      series("ma", "Volume MA", simpleMovingAverage(candles, values.period, (candle) => candle.volume)),
    );
  }
  return { status: "invalid", series: [], message: `Unsupported indicator: ${instance.definitionId}.` };
}

export function createIndicatorCalculator(instance: IndicatorInstance, initialInput: IndicatorInput = { candles: [] }): IndicatorCalculator {
  let input = normalizeInput(initialInput);
  let result = calculateIndicator(instance, input);
  const recompute = () => (result = calculateIndicator(instance, input));
  return {
    reset(next) {
      input = normalizeInput(next);
      return recompute();
    },
    applyPatch(patch) {
      if (patch.type === "noChange") return result;
      if (patch.type === "reset") input = normalizeInput({ candles: patch.candles });
      if (patch.type === "append") input = mergeInput(input, patch.candles, "append");
      if (patch.type === "prepend") input = mergeInput(input, patch.candles, "prepend");
      if (patch.type === "updateLatest") input = mergeInput(input, [patch.candle]);
      return recompute();
    },
    getInput: () => input,
    getResult: () => result,
  };
}

function ready(...values: IndicatorSeries[]): IndicatorResult {
  return { status: "ready", series: values };
}

function series(key: string, label: string, points: readonly IndicatorPoint[]): IndicatorSeries {
  return { key, label, points };
}

function normalizeInput(input: IndicatorInput): IndicatorInput {
  return { candles: normalizeCandles(input.candles) };
}

function mergeInput(
  input: IndicatorInput,
  candles: readonly ChartCandle[],
  position: "append" | "prepend" = "append",
): IndicatorInput {
  return {
    candles: normalizeCandles(position === "append" ? [...input.candles, ...candles] : [...candles, ...input.candles]),
  };
}

function normalizeCandles(candles: readonly ChartCandle[]): readonly ChartCandle[] {
  const byTime = new Map<number, ChartCandle>();
  for (const candle of candles) {
    if (isCandle(candle)) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function isCandle(candle: ChartCandle): boolean {
  return [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
    && candle.high >= candle.low && candle.volume >= 0;
}

function simpleMovingAverage(candles: readonly ChartCandle[], period: number, select: (candle: ChartCandle) => number): IndicatorPoint[] {
  const points: IndicatorPoint[] = [];
  let sum = 0;
  for (let index = 0; index < candles.length; index += 1) {
    sum += select(candles[index]);
    if (index >= period) sum -= select(candles[index - period]);
    if (index >= period - 1) points.push({ time: candles[index].time, value: sum / period });
  }
  return points;
}

function exponentialMovingAverage(candles: readonly ChartCandle[], period: number, select: (candle: ChartCandle) => number): IndicatorPoint[] {
  if (candles.length < period) return [];
  const points: IndicatorPoint[] = [];
  let current = 0;
  for (let index = 0; index < period; index += 1) current += select(candles[index]);
  current /= period;
  points.push({ time: candles[period - 1].time, value: current });
  const multiplier = 2 / (period + 1);
  for (let index = period; index < candles.length; index += 1) {
    current = (select(candles[index]) - current) * multiplier + current;
    points.push({ time: candles[index].time, value: current });
  }
  return points;
}

function vwap(candles: readonly ChartCandle[]): IndicatorPoint[] {
  let volume = 0;
  let weighted = 0;
  const points: IndicatorPoint[] = [];
  for (const candle of candles) {
    volume += candle.volume;
    weighted += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    if (volume > 0) points.push({ time: candle.time, value: weighted / volume });
  }
  return points;
}

function bollinger(candles: readonly ChartCandle[], period: number, multiplier: number): IndicatorSeries[] {
  const middle: IndicatorPoint[] = [];
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    let sum = 0;
    for (let offset = 0; offset < period; offset += 1) sum += candles[index - offset].close;
    const average = sum / period;
    let variance = 0;
    for (let offset = 0; offset < period; offset += 1) variance += (candles[index - offset].close - average) ** 2;
    const deviation = Math.sqrt(variance / period) * multiplier;
    const time = candles[index].time;
    middle.push({ time, value: average });
    upper.push({ time, value: average + deviation });
    lower.push({ time, value: average - deviation });
  }
  return [series("middle", "Middle", middle), series("upper", "Upper", upper), series("lower", "Lower", lower)];
}

function donchian(candles: readonly ChartCandle[], period: number): IndicatorSeries[] {
  const upper: IndicatorPoint[] = [];
  const middle: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    let highest = Number.NEGATIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < period; offset += 1) {
      highest = Math.max(highest, candles[index - offset].high);
      lowest = Math.min(lowest, candles[index - offset].low);
    }
    const time = candles[index].time;
    upper.push({ time, value: highest });
    lower.push({ time, value: lowest });
    middle.push({ time, value: (highest + lowest) / 2 });
  }
  return [series("upper", "Upper", upper), series("middle", "Middle", middle), series("lower", "Lower", lower)];
}

function keltner(candles: readonly ChartCandle[], period: number, atrPeriod: number, multiplier: number): IndicatorSeries[] {
  const middle = exponentialMovingAverage(candles, period, (candle) => candle.close);
  const atrByTime = new Map(atr(candles, atrPeriod).map((point) => [point.time, point.value]));
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  for (const point of middle) {
    const range = atrByTime.get(point.time);
    if (!Number.isFinite(range)) continue;
    upper.push({ time: point.time, value: point.value + range! * multiplier });
    lower.push({ time: point.time, value: point.value - range! * multiplier });
  }
  return [series("middle", "Middle", middle), series("upper", "Upper", upper), series("lower", "Lower", lower)];
}

function parabolicSar(candles: readonly ChartCandle[], step: number, maxStep: number): IndicatorPoint[] {
  if (candles.length < 2) return [];
  const points: IndicatorPoint[] = [];
  let rising = candles[1].close >= candles[0].close;
  let acceleration = step;
  let extreme = rising ? Math.max(candles[0].high, candles[1].high) : Math.min(candles[0].low, candles[1].low);
  let current = rising ? Math.min(candles[0].low, candles[1].low) : Math.max(candles[0].high, candles[1].high);
  points.push({ time: candles[1].time, value: current });

  for (let index = 2; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const beforePrevious = candles[index - 2];
    current += acceleration * (extreme - current);
    current = rising
      ? Math.min(current, previous.low, beforePrevious.low)
      : Math.max(current, previous.high, beforePrevious.high);

    const reversed = rising ? candle.low < current : candle.high > current;
    if (reversed) {
      rising = !rising;
      current = extreme;
      extreme = rising ? candle.high : candle.low;
      acceleration = step;
    } else if (rising) {
      if (candle.high > extreme) {
        extreme = candle.high;
        acceleration = Math.min(maxStep, acceleration + step);
      }
    } else if (candle.low < extreme) {
      extreme = candle.low;
      acceleration = Math.min(maxStep, acceleration + step);
    }
    points.push({ time: candle.time, value: current });
  }
  return points;
}

function supertrend(candles: readonly ChartCandle[], period: number, multiplier: number): IndicatorPoint[] {
  const atrByTime = new Map(atr(candles, period).map((point) => [point.time, point.value]));
  const points: IndicatorPoint[] = [];
  let previousUpper = Number.NaN;
  let previousLower = Number.NaN;
  let previousTrend = Number.NaN;
  let previousClose = Number.NaN;

  for (const candle of candles) {
    const range = atrByTime.get(candle.time);
    if (range === undefined || !Number.isFinite(range)) {
      previousClose = candle.close;
      continue;
    }
    const midpoint = (candle.high + candle.low) / 2;
    const basicUpper = midpoint + multiplier * range;
    const basicLower = midpoint - multiplier * range;
    const upper = !Number.isFinite(previousUpper) || basicUpper < previousUpper || previousClose > previousUpper
      ? basicUpper
      : previousUpper;
    const lower = !Number.isFinite(previousLower) || basicLower > previousLower || previousClose < previousLower
      ? basicLower
      : previousLower;
    const trend = !Number.isFinite(previousTrend)
      ? (candle.close <= upper ? upper : lower)
      : previousTrend === previousUpper
        ? (candle.close <= upper ? upper : lower)
        : (candle.close >= lower ? lower : upper);
    points.push({ time: candle.time, value: trend });
    previousUpper = upper;
    previousLower = lower;
    previousTrend = trend;
    previousClose = candle.close;
  }
  return points;
}

function ichimoku(candles: readonly ChartCandle[], conversionPeriod: number, basePeriod: number, spanBPeriod: number): IndicatorSeries[] {
  const conversion: IndicatorPoint[] = [];
  const base: IndicatorPoint[] = [];
  const spanA: IndicatorPoint[] = [];
  const spanB: IndicatorPoint[] = [];
  const conversionByTime = new Map<number, number>();
  const baseByTime = new Map<number, number>();

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (index >= conversionPeriod - 1) {
      const value = midpointRange(candles, index, conversionPeriod);
      conversion.push({ time: candle.time, value });
      conversionByTime.set(candle.time, value);
    }
    if (index >= basePeriod - 1) {
      const value = midpointRange(candles, index, basePeriod);
      base.push({ time: candle.time, value });
      baseByTime.set(candle.time, value);
    }
    const conversionValue = conversionByTime.get(candle.time);
    const baseValue = baseByTime.get(candle.time);
    if (Number.isFinite(conversionValue) && Number.isFinite(baseValue)) {
      spanA.push({ time: candle.time, value: (conversionValue! + baseValue!) / 2 });
    }
    if (index >= spanBPeriod - 1) spanB.push({ time: candle.time, value: midpointRange(candles, index, spanBPeriod) });
  }
  return [
    series("conversion", "Conversion", conversion),
    series("base", "Base", base),
    series("spanA", "Span A", spanA),
    series("spanB", "Span B", spanB),
  ];
}

function midpointRange(candles: readonly ChartCandle[], index: number, period: number): number {
  let highest = Number.NEGATIVE_INFINITY;
  let lowest = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < period; offset += 1) {
    const candle = candles[index - offset];
    highest = Math.max(highest, candle.high);
    lowest = Math.min(lowest, candle.low);
  }
  return (highest + lowest) / 2;
}

function rsi(candles: readonly ChartCandle[], period: number): IndicatorPoint[] {
  if (candles.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= period;
  loss /= period;
  const points: IndicatorPoint[] = [{ time: candles[period].time, value: relativeStrength(gain, loss) }];
  for (let index = period + 1; index < candles.length; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    points.push({ time: candles[index].time, value: relativeStrength(gain, loss) });
  }
  return points;
}

function relativeStrength(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

function macd(candles: readonly ChartCandle[], fast: number, slow: number, signalPeriod: number): IndicatorSeries[] {
  const fastByTime = new Map(exponentialMovingAverage(candles, fast, (candle) => candle.close).map((point) => [point.time, point.value]));
  const macdPoints = exponentialMovingAverage(candles, slow, (candle) => candle.close)
    .map((point) => ({ time: point.time, value: (fastByTime.get(point.time) ?? point.value) - point.value }));
  if (macdPoints.length < signalPeriod) return [series("macd", "MACD", macdPoints), series("signal", "Signal", []), series("histogram", "Histogram", [])];
  const synthetic = macdPoints.map((point) => ({ time: point.time, open: point.value, high: point.value, low: point.value, close: point.value, volume: 0 }));
  const signal = exponentialMovingAverage(synthetic, signalPeriod, (candle) => candle.close);
  const histogram = signal.map((point) => ({ time: point.time, value: (macdPoints.find((item) => item.time === point.time)?.value ?? point.value) - point.value }));
  return [series("macd", "MACD", macdPoints), series("signal", "Signal", signal), series("histogram", "Histogram", histogram)];
}

function kdj(candles: readonly ChartCandle[], period: number, kPeriod: number, dPeriod: number): IndicatorSeries[] {
  const rawK: IndicatorPoint[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let offset = 0; offset < period; offset += 1) {
      highest = Math.max(highest, candles[index - offset].high);
      lowest = Math.min(lowest, candles[index - offset].low);
    }
    rawK.push({ time: candles[index].time, value: highest === lowest ? 50 : ((candles[index].close - lowest) / (highest - lowest)) * 100 });
  }
  const smoothedK = smoothPoints(rawK, kPeriod);
  const smoothedD = smoothPoints(smoothedK, dPeriod);
  const j = smoothedD.map((point) => ({ time: point.time, value: 3 * (smoothedK.find((item) => item.time === point.time)?.value ?? point.value) - 2 * point.value }));
  return [series("k", "K", smoothedK), series("d", "D", smoothedD), series("j", "J", j)];
}

function smoothPoints(points: readonly IndicatorPoint[], period: number): IndicatorPoint[] {
  const candles = points.map((point) => ({ time: point.time, open: point.value, high: point.value, low: point.value, close: point.value, volume: 0 }));
  return simpleMovingAverage(candles, period, (candle) => candle.close);
}

function atr(candles: readonly ChartCandle[], period: number): IndicatorPoint[] {
  if (candles.length <= period) return [];
  const ranges: IndicatorPoint[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    ranges.push({ time: candle.time, value: Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close)) });
  }
  let current = ranges.slice(0, period).reduce((sum, point) => sum + point.value, 0) / period;
  const points: IndicatorPoint[] = [{ time: ranges[period - 1].time, value: current }];
  for (let index = period; index < ranges.length; index += 1) {
    current = (current * (period - 1) + ranges[index].value) / period;
    points.push({ time: ranges[index].time, value: current });
  }
  return points;
}

function adxDmi(candles: readonly ChartCandle[], period: number): IndicatorSeries[] {
  if (candles.length <= period) return [series("adx", "ADX", []), series("plusDi", "+DI", []), series("minusDi", "-DI", [])];
  const records: { time: number; tr: number; plusDm: number; minusDm: number }[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    records.push({
      time: current.time,
      tr: Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)),
      plusDm: upMove > downMove && upMove > 0 ? upMove : 0,
      minusDm: downMove > upMove && downMove > 0 ? downMove : 0,
    });
  }
  if (records.length < period) return [series("adx", "ADX", []), series("plusDi", "+DI", []), series("minusDi", "-DI", [])];

  let smoothedTr = records.slice(0, period).reduce((sum, item) => sum + item.tr, 0);
  let smoothedPlus = records.slice(0, period).reduce((sum, item) => sum + item.plusDm, 0);
  let smoothedMinus = records.slice(0, period).reduce((sum, item) => sum + item.minusDm, 0);
  const plusDi: IndicatorPoint[] = [];
  const minusDi: IndicatorPoint[] = [];
  const dx: IndicatorPoint[] = [];

  for (let index = period - 1; index < records.length; index += 1) {
    if (index > period - 1) {
      const item = records[index];
      smoothedTr = smoothedTr - smoothedTr / period + item.tr;
      smoothedPlus = smoothedPlus - smoothedPlus / period + item.plusDm;
      smoothedMinus = smoothedMinus - smoothedMinus / period + item.minusDm;
    }
    const denominator = smoothedTr > 0 ? smoothedTr : Number.POSITIVE_INFINITY;
    const plus = denominator === Number.POSITIVE_INFINITY ? 0 : (100 * smoothedPlus) / denominator;
    const minus = denominator === Number.POSITIVE_INFINITY ? 0 : (100 * smoothedMinus) / denominator;
    const directionalSum = plus + minus;
    const value = directionalSum === 0 ? 0 : (100 * Math.abs(plus - minus)) / directionalSum;
    const time = records[index].time;
    plusDi.push({ time, value: plus });
    minusDi.push({ time, value: minus });
    dx.push({ time, value });
  }

  if (dx.length < period) return [series("adx", "ADX", []), series("plusDi", "+DI", plusDi), series("minusDi", "-DI", minusDi)];
  let currentAdx = dx.slice(0, period).reduce((sum, point) => sum + point.value, 0) / period;
  const adx: IndicatorPoint[] = [{ time: dx[period - 1].time, value: currentAdx }];
  for (let index = period; index < dx.length; index += 1) {
    currentAdx = (currentAdx * (period - 1) + dx[index].value) / period;
    adx.push({ time: dx[index].time, value: currentAdx });
  }
  return [series("adx", "ADX", adx), series("plusDi", "+DI", plusDi), series("minusDi", "-DI", minusDi)];
}

function stochastic(candles: readonly ChartCandle[], period: number, kSmoothing: number, dPeriod: number): IndicatorSeries[] {
  const rawK: IndicatorPoint[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    let highest = Number.NEGATIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < period; offset += 1) {
      highest = Math.max(highest, candles[index - offset].high);
      lowest = Math.min(lowest, candles[index - offset].low);
    }
    rawK.push({ time: candles[index].time, value: highest === lowest ? 50 : ((candles[index].close - lowest) / (highest - lowest)) * 100 });
  }
  const k = smoothPoints(rawK, kSmoothing);
  const d = smoothPoints(k, dPeriod);
  return [series("k", "%K", k), series("d", "%D", d)];
}

function cci(candles: readonly ChartCandle[], period: number): IndicatorPoint[] {
  const typicalPrices = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);
  const points: IndicatorPoint[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    let sum = 0;
    for (let offset = 0; offset < period; offset += 1) sum += typicalPrices[index - offset];
    const average = sum / period;
    let deviation = 0;
    for (let offset = 0; offset < period; offset += 1) deviation += Math.abs(typicalPrices[index - offset] - average);
    const meanDeviation = deviation / period;
    points.push({ time: candles[index].time, value: meanDeviation === 0 ? 0 : (typicalPrices[index] - average) / (0.015 * meanDeviation) });
  }
  return points;
}

function roc(candles: readonly ChartCandle[], period: number): IndicatorPoint[] {
  const points: IndicatorPoint[] = [];
  for (let index = period; index < candles.length; index += 1) {
    const baseline = candles[index - period].close;
    points.push({ time: candles[index].time, value: baseline === 0 ? 0 : ((candles[index].close - baseline) / baseline) * 100 });
  }
  return points;
}

function aroon(candles: readonly ChartCandle[], period: number): IndicatorSeries[] {
  const up: IndicatorPoint[] = [];
  const down: IndicatorPoint[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    let highest = Number.NEGATIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    let barsSinceHigh = 0;
    let barsSinceLow = 0;
    for (let offset = 0; offset < period; offset += 1) {
      const candle = candles[index - offset];
      if (candle.high >= highest) {
        highest = candle.high;
        barsSinceHigh = offset;
      }
      if (candle.low <= lowest) {
        lowest = candle.low;
        barsSinceLow = offset;
      }
    }
    const time = candles[index].time;
    const divisor = Math.max(1, period - 1);
    up.push({ time, value: ((divisor - barsSinceHigh) / divisor) * 100 });
    down.push({ time, value: ((divisor - barsSinceLow) / divisor) * 100 });
  }
  return [series("up", "Aroon Up", up), series("down", "Aroon Down", down)];
}

function trix(candles: readonly ChartCandle[], period: number, signalPeriod: number): IndicatorSeries[] {
  const first = exponentialMovingAverage(candles, period, (candle) => candle.close);
  const second = emaPoints(first, period);
  const third = emaPoints(second, period);
  const trixPoints: IndicatorPoint[] = [];
  for (let index = 1; index < third.length; index += 1) {
    const previous = third[index - 1].value;
    trixPoints.push({
      time: third[index].time,
      value: previous === 0 ? 0 : ((third[index].value - previous) / previous) * 100,
    });
  }
  return [series("trix", "TRIX", trixPoints), series("signal", "Signal", emaPoints(trixPoints, signalPeriod))];
}

function emaPoints(points: readonly IndicatorPoint[], period: number): IndicatorPoint[] {
  if (points.length < period) return [];
  const synthetic = points.map((point) => ({ time: point.time, open: point.value, high: point.value, low: point.value, close: point.value, volume: 0 }));
  return exponentialMovingAverage(synthetic, period, (candle) => candle.close);
}

function williamsR(candles: readonly ChartCandle[], period: number): IndicatorPoint[] {
  const points: IndicatorPoint[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    let highest = Number.NEGATIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < period; offset += 1) {
      highest = Math.max(highest, candles[index - offset].high);
      lowest = Math.min(lowest, candles[index - offset].low);
    }
    points.push({ time: candles[index].time, value: highest === lowest ? -50 : ((highest - candles[index].close) / (highest - lowest)) * -100 });
  }
  return points;
}

function mfi(candles: readonly ChartCandle[], period: number): IndicatorPoint[] {
  if (candles.length <= period) return [];
  const typicalPrices = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);
  const flows = candles.map((candle, index) => ({
    positive: index === 0 || typicalPrices[index] === typicalPrices[index - 1] ? 0 : typicalPrices[index] > typicalPrices[index - 1] ? typicalPrices[index] * candle.volume : 0,
    negative: index === 0 || typicalPrices[index] === typicalPrices[index - 1] ? 0 : typicalPrices[index] < typicalPrices[index - 1] ? typicalPrices[index] * candle.volume : 0,
  }));
  const points: IndicatorPoint[] = [];
  for (let index = period; index < candles.length; index += 1) {
    let positive = 0;
    let negative = 0;
    for (let offset = 0; offset < period; offset += 1) {
      const flow = flows[index - offset];
      positive += flow.positive;
      negative += flow.negative;
    }
    const value = negative === 0 ? positive === 0 ? 50 : 100 : 100 - 100 / (1 + positive / negative);
    points.push({ time: candles[index].time, value });
  }
  return points;
}

function chaikinMoneyFlow(candles: readonly ChartCandle[], period: number): IndicatorPoint[] {
  const points: IndicatorPoint[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    let moneyFlowVolume = 0;
    let volume = 0;
    for (let offset = 0; offset < period; offset += 1) {
      const candle = candles[index - offset];
      const range = candle.high - candle.low;
      const multiplier = range === 0 ? 0 : ((candle.close - candle.low) - (candle.high - candle.close)) / range;
      moneyFlowVolume += multiplier * candle.volume;
      volume += candle.volume;
    }
    points.push({ time: candles[index].time, value: volume === 0 ? 0 : moneyFlowVolume / volume });
  }
  return points;
}

function obv(candles: readonly ChartCandle[]): IndicatorPoint[] {
  if (candles.length === 0) return [];
  let current = 0;
  const points: IndicatorPoint[] = [{ time: candles[0].time, value: current }];
  for (let index = 1; index < candles.length; index += 1) {
    current += candles[index].close > candles[index - 1].close ? candles[index].volume : candles[index].close < candles[index - 1].close ? -candles[index].volume : 0;
    points.push({ time: candles[index].time, value: current });
  }
  return points;
}
