import {
  INDICATOR_DEFINITIONS,
  calculateIndicator,
  type IndicatorInstance,
  type IndicatorParameters,
} from "./chartIndicators";
import {
  parseChartIndicatorDsl,
  type ChartIndicatorDslDocument,
  type DslBooleanExpression,
  type DslNumberExpression,
} from "./chartIndicatorDsl";

export type ChartAlertExpression = Readonly<Record<string, unknown>>;

export type ChartAlertIndicatorOutput = Readonly<{
  key: string;
  label: string;
  expression: ChartAlertExpression;
}>;

export type ChartAlertIndicatorOption = Readonly<{
  id: string;
  source: "builtin" | "custom";
  label: string;
  optionLabel: string;
  visible: boolean;
  instance?: IndicatorInstance;
  scriptId?: string;
  outputs: readonly ChartAlertIndicatorOutput[];
  unavailableReason?: string;
}>;

type SelectedChartScript = Readonly<{
  id: string;
  name: string;
  source: string;
  runtime?: "dsl" | "legacy-js";
  enabled: boolean;
  hidden: boolean;
}>;

const OUTPUT_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ma: { ma: "MA" },
  ema: { ema: "EMA" },
  vwap: { vwap: "VWAP" },
  boll: { middle: "中轨", upper: "上轨", lower: "下轨" },
  donchian: { upper: "上轨", middle: "中轨", lower: "下轨" },
  keltner: { middle: "中轨", upper: "上轨", lower: "下轨" },
  psar: { psar: "SAR" },
  supertrend: { supertrend: "Supertrend" },
  ichimoku: { conversion: "转换线", base: "基准线", spanA: "先行带 A", spanB: "先行带 B" },
  rsi: { rsi: "RSI" },
  macd: { macd: "MACD", signal: "Signal", histogram: "Histogram" },
  kdj: { k: "K", d: "D", j: "J" },
  atr: { atr: "ATR" },
  adx: { adx: "ADX", plusDi: "+DI", minusDi: "-DI" },
  stochastic: { k: "%K", d: "%D" },
  cci: { cci: "CCI" },
  roc: { roc: "ROC" },
  aroon: { up: "Aroon Up", down: "Aroon Down" },
  trix: { trix: "TRIX", signal: "Signal" },
  "williams-r": { williamsR: "Williams %R" },
  mfi: { mfi: "MFI" },
  cmf: { cmf: "CMF" },
  obv: { obv: "OBV" },
  "volume-ma": { volume: "成交量", ma: "Volume MA" },
};

export function buildChartAlertIndicatorOptions(
  instances: readonly IndicatorInstance[],
  scripts: readonly SelectedChartScript[],
): readonly ChartAlertIndicatorOption[] {
  const builtIns = instances.map((instance): ChartAlertIndicatorOption => {
    const definition = INDICATOR_DEFINITIONS[instance.definitionId];
    const parameters = resolveBuiltInParameters(instance.parameters, definition.parameters);
    const label = builtInInstanceLabel(instance, parameters);
    const validation = calculateIndicator({ ...instance, parameters }, { candles: [] });
    const unavailableReason = validation.status === "invalid"
      ? validation.message ?? "指标参数无效"
      : definition.parameters.some((parameter) => parameter.type === "integer" && parameters[parameter.key] > 500)
      ? "指标周期超过后台提醒上限 500"
      : undefined;
    return {
      id: instance.id,
      source: "builtin",
      label,
      optionLabel: `${label}${unavailableReason ? " · 暂不可提醒" : instance.visible ? "" : " · 已隐藏"}`,
      visible: instance.visible,
      instance,
      outputs: unavailableReason ? [] : definition.outputKeys.map((key) => ({
        key,
        label: OUTPUT_LABELS[definition.id]?.[key] ?? key,
        expression: {
          kind: "builtInIndicator",
          definitionId: definition.id,
          outputKey: key,
          parameters,
        },
      })),
      unavailableReason,
    };
  });

  const custom = scripts.filter((script) => script.enabled).map((script): ChartAlertIndicatorOption => {
    if (script.runtime !== "dsl") {
      return unavailableCustomOption(script, "旧版脚本需转换为安全 DSL");
    }
    const parsed = parseChartIndicatorDsl(script.source);
    if (!parsed.document) {
      return unavailableCustomOption(script, "DSL 格式无效");
    }
    const parameters = Object.fromEntries(parsed.document.parameters.map((parameter) => [parameter.key, parameter.defaultValue]));
    try {
      return {
        id: script.id,
        source: "custom",
        label: script.name,
        optionLabel: `${script.name} · 自定义${script.hidden ? " · 已隐藏" : ""}`,
        visible: !script.hidden,
        scriptId: script.id,
        outputs: parsed.document.outputs.map((output) => ({
          key: output.id,
          label: output.label ?? output.id,
          expression: compileDslNumberExpression(output.expression, parsed.document!, parameters),
        })),
      };
    } catch (error) {
      return unavailableCustomOption(script, error instanceof Error ? error.message : "DSL 无法用于后台提醒");
    }
  });
  return [...builtIns, ...custom];
}

function unavailableCustomOption(script: SelectedChartScript, unavailableReason: string): ChartAlertIndicatorOption {
  return {
    id: script.id,
    source: "custom",
    label: script.name,
    optionLabel: `${script.name} · 暂不可提醒`,
    visible: !script.hidden,
    scriptId: script.id,
    outputs: [],
    unavailableReason,
  };
}

function resolveBuiltInParameters(
  supplied: IndicatorParameters | undefined,
  definitions: readonly Readonly<{ key: string; defaultValue: number }>[],
): Readonly<Record<string, number>> {
  return Object.fromEntries(definitions.map((definition) => {
    const candidate = supplied?.[definition.key];
    return [definition.key, typeof candidate === "number" && Number.isFinite(candidate) ? candidate : definition.defaultValue];
  }));
}

function builtInInstanceLabel(instance: IndicatorInstance, parameters: Readonly<Record<string, number>>): string {
  const definition = INDICATOR_DEFINITIONS[instance.definitionId];
  const values = definition.parameters.map((parameter) => parameters[parameter.key]).filter(Number.isFinite);
  return `${definition.name}${values.length > 0 ? ` ${values.join(", ")}` : ""}`;
}

function compileDslNumberExpression(
  expression: DslNumberExpression,
  document: ChartIndicatorDslDocument,
  parameters: Readonly<Record<string, number>>,
): ChartAlertExpression {
  switch (expression.type) {
    case "number": return { kind: "number", value: expression.value };
    case "field": return { kind: "field", field: expression.field };
    case "parameter": return { kind: "number", value: parameterValue(expression.key, parameters) };
    case "unary": return {
      kind: "unary",
      op: expression.op,
      value: compileDslNumberExpression(expression.value, document, parameters),
    };
    case "binary": return {
      kind: "arithmetic",
      op: expression.op,
      left: compileDslNumberExpression(expression.left, document, parameters),
      right: compileDslNumberExpression(expression.right, document, parameters),
    };
    case "if": return {
      kind: "conditional",
      if: compileDslBooleanExpression(expression.when, document, parameters),
      thenValue: compileDslNumberExpression(expression.then, document, parameters),
      elseValue: compileDslNumberExpression(expression.else, document, parameters),
    };
    case "call": {
      if (expression.name === "abs") {
        return { kind: "unary", op: "absolute", value: compileDslNumberExpression(expression.args[0], document, parameters) };
      }
      if (expression.name === "min" || expression.name === "max") {
        return {
          kind: "pairwise",
          function: expression.name,
          left: compileDslNumberExpression(expression.args[0], document, parameters),
          right: compileDslNumberExpression(expression.args[1], document, parameters),
        };
      }
      if (expression.name === "vwap") return { kind: "technical", function: "vwap", window: null };
      if (expression.name === "rsi" || expression.name === "atr") {
        return { kind: "technical", function: expression.name, window: staticPeriod(expression.args[0], document, parameters) };
      }
      return {
        kind: "rolling",
        function: expression.name,
        input: compileDslNumberExpression(expression.args[0], document, parameters),
        window: staticPeriod(expression.args[1], document, parameters),
      };
    }
  }
}

function compileDslBooleanExpression(
  expression: DslBooleanExpression,
  document: ChartIndicatorDslDocument,
  parameters: Readonly<Record<string, number>>,
): ChartAlertExpression {
  switch (expression.type) {
    case "boolean": return { kind: "boolean", value: expression.value };
    case "compare": return {
      kind: "comparison",
      op: ({ greater: "greaterThan", greaterEqual: "greaterOrEqual", less: "lessThan", lessEqual: "lessOrEqual", equal: "equal", notEqual: "notEqual" } as const)[expression.op],
      left: compileDslNumberExpression(expression.left, document, parameters),
      right: compileDslNumberExpression(expression.right, document, parameters),
    };
    case "logical": return {
      kind: "logical",
      op: expression.op,
      left: compileDslBooleanExpression(expression.left, document, parameters),
      right: compileDslBooleanExpression(expression.right, document, parameters),
    };
    case "not": return { kind: "not", value: compileDslBooleanExpression(expression.value, document, parameters) };
  }
}

function staticPeriod(
  expression: DslNumberExpression | undefined,
  document: ChartIndicatorDslDocument,
  parameters: Readonly<Record<string, number>>,
): number {
  if (!expression) throw new Error("指标周期缺失");
  const value = expression.type === "number"
    ? expression.value
    : expression.type === "parameter"
      ? parameterValue(expression.key, parameters)
      : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("指标周期必须是 1-500 的固定值或有界参数");
  }
  return value;
}

function parameterValue(key: string, parameters: Readonly<Record<string, number>>): number {
  const value = parameters[key];
  if (!Number.isFinite(value)) throw new Error(`参数 ${key} 无效`);
  return value;
}
