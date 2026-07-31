/**
 * Safe, deterministic chart-indicator DSL foundation.
 *
 * This module deliberately accepts JSON-shaped AST data instead of source code.
 * There is no dynamic JavaScript evaluation path: every node, function and output
 * is parsed, validated and interpreted by an explicit whitelist.
 */

import type { ChartCandle } from "./chartIndicators";

export const CHART_INDICATOR_DSL_SCHEMA_VERSION = 1;

export type ChartIndicatorDslBudget = Readonly<{
  maxNodes: number;
  maxDepth: number;
  maxLookback: number;
  maxOutputs: number;
  maxBars: number;
  maxOperations: number;
}>;

export const DEFAULT_CHART_INDICATOR_DSL_BUDGET: ChartIndicatorDslBudget = {
  maxNodes: 300,
  maxDepth: 24,
  maxLookback: 1_000,
  maxOutputs: 8,
  maxBars: 20_000,
  maxOperations: 2_000_000,
};

export type DslDiagnosticSeverity = "error" | "warning";

export type DslDiagnostic = Readonly<{
  severity: DslDiagnosticSeverity;
  path: string;
  message: string;
}>;

export type DslParameterSchema = Readonly<{
  key: string;
  label?: string;
  type: "number" | "integer";
  defaultValue: number;
  min?: number;
  max?: number;
}>;

export type DslOutput = Readonly<{
  id: string;
  label?: string;
  pane: "main" | "sub";
  kind: "line" | "histogram" | "area";
  color?: string;
  expression: DslNumberExpression;
}>;

export type ChartIndicatorDslDocument = Readonly<{
  schemaVersion: typeof CHART_INDICATOR_DSL_SCHEMA_VERSION;
  name: string;
  parameters: readonly DslParameterSchema[];
  outputs: readonly DslOutput[];
}>;

export type DslPriceField = "open" | "high" | "low" | "close" | "volume" | "hl2" | "hlc3" | "ohlc4";
export type DslBinaryOperator = "add" | "subtract" | "multiply" | "divide" | "modulo" | "power";
export type DslComparisonOperator = "greater" | "greaterEqual" | "less" | "lessEqual" | "equal" | "notEqual";
export type DslBuiltinName = "abs" | "min" | "max" | "sma" | "ema" | "rsi" | "atr" | "vwap" | "highest" | "lowest" | "stddev";

export type DslNumberExpression =
  | Readonly<{ type: "number"; value: number }>
  | Readonly<{ type: "field"; field: DslPriceField }>
  | Readonly<{ type: "parameter"; key: string }>
  | Readonly<{ type: "unary"; op: "negate" | "absolute"; value: DslNumberExpression }>
  | Readonly<{ type: "binary"; op: DslBinaryOperator; left: DslNumberExpression; right: DslNumberExpression }>
  | Readonly<{ type: "if"; when: DslBooleanExpression; then: DslNumberExpression; else: DslNumberExpression }>
  | Readonly<{ type: "call"; name: DslBuiltinName; args: readonly DslNumberExpression[] }>;

export type DslBooleanExpression =
  | Readonly<{ type: "boolean"; value: boolean }>
  | Readonly<{ type: "compare"; op: DslComparisonOperator; left: DslNumberExpression; right: DslNumberExpression }>
  | Readonly<{ type: "logical"; op: "and" | "or"; left: DslBooleanExpression; right: DslBooleanExpression }>
  | Readonly<{ type: "not"; value: DslBooleanExpression }>;

export type ParsedChartIndicatorDsl = Readonly<{
  document: ChartIndicatorDslDocument | null;
  diagnostics: readonly DslDiagnostic[];
}>;

export type ChartIndicatorDslPoint = Readonly<{ time: number; value: number }>;
export type ChartIndicatorDslSeries = Readonly<{
  id: string;
  label: string;
  pane: DslOutput["pane"];
  kind: DslOutput["kind"];
  color?: string;
  points: readonly ChartIndicatorDslPoint[];
}>;

export type ChartIndicatorDslEvaluation = Readonly<{
  ok: boolean;
  series: readonly ChartIndicatorDslSeries[];
  diagnostics: readonly DslDiagnostic[];
  operations: number;
}>;

const PRICE_FIELDS = new Set<DslPriceField>(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]);
const BUILTIN_ARITY: Readonly<Record<DslBuiltinName, readonly [number, number]>> = {
  abs: [1, 1],
  min: [2, 2],
  max: [2, 2],
  sma: [2, 2],
  ema: [2, 2],
  rsi: [1, 1],
  atr: [1, 1],
  vwap: [0, 0],
  highest: [2, 2],
  lowest: [2, 2],
  stddev: [2, 2],
};

const BUILTIN_NAMES = new Set<DslBuiltinName>(Object.keys(BUILTIN_ARITY) as DslBuiltinName[]);
const PARAMETER_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const OUTPUT_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** Parse and statically validate a compact JSON AST document. */
export function parseChartIndicatorDsl(input: unknown, budget: Partial<ChartIndicatorDslBudget> = {}): ParsedChartIndicatorDsl {
  const resolvedBudget = resolveBudget(budget);
  const diagnostics: DslDiagnostic[] = [];
  const root = parseJsonInput(input, diagnostics);
  if (!root) return { document: null, diagnostics };

  const schemaVersion = readNumber(root.schemaVersion, "/schemaVersion", diagnostics);
  if (schemaVersion !== CHART_INDICATOR_DSL_SCHEMA_VERSION) {
    diagnostics.push(error("/schemaVersion", `Expected schemaVersion ${CHART_INDICATOR_DSL_SCHEMA_VERSION}.`));
  }
  const name = readString(root.name, "/name", diagnostics, 1, 120) ?? "Untitled indicator";
  const parameters = parseParameters(root.parameters, diagnostics);
  const parameterKeys = new Set(parameters.map((parameter) => parameter.key));
  const outputs = parseOutputs(root.outputs, parameterKeys, diagnostics, resolvedBudget);
  validateTreeResources(outputs, parameters, diagnostics, resolvedBudget);

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { document: null, diagnostics };
  }
  return {
    document: {
      schemaVersion: CHART_INDICATOR_DSL_SCHEMA_VERSION,
      name,
      parameters,
      outputs,
    },
    diagnostics,
  };
}

/** Evaluate a previously parsed document against finite OHLCV candle data. */
export function evaluateChartIndicatorDsl(
  document: ChartIndicatorDslDocument,
  candles: readonly ChartCandle[],
  parameterValues: Readonly<Record<string, number>> = {},
  budget: Partial<ChartIndicatorDslBudget> = {},
): ChartIndicatorDslEvaluation {
  const resolvedBudget = resolveBudget(budget);
  const diagnostics: DslDiagnostic[] = [];
  const parsed = parseChartIndicatorDsl(document, resolvedBudget);
  if (!parsed.document) return { ok: false, series: [], diagnostics: parsed.diagnostics, operations: 0 };

  const normalizedCandles = normalizeCandles(candles, resolvedBudget, diagnostics);
  const parameters = resolveParameters(parsed.document.parameters, parameterValues, diagnostics);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, series: [], diagnostics, operations: 0 };
  }

  const evaluator = new DslEvaluator(normalizedCandles, parameters, resolvedBudget, diagnostics);
  const series = parsed.document.outputs.map((output) => ({
    id: output.id,
    label: output.label ?? output.id,
    pane: output.pane,
    kind: output.kind,
    color: output.color,
    points: evaluator.evaluateOutput(output),
  }));
  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    series,
    diagnostics,
    operations: evaluator.operations,
  };
}

/**
 * Pure smoke assertions for a unit-test runner or a development smoke command.
 * It is intentionally not invoked on module load.
 */
export function runChartIndicatorDslSmokeAssertions(): void {
  const source = {
    schemaVersion: 1,
    name: "Deterministic MA filter",
    parameters: [{ key: "length", type: "integer", defaultValue: 3, min: 1, max: 10 }],
    outputs: [{
      id: "filtered",
      pane: "main",
      kind: "line",
      expression: {
        type: "if",
        when: {
          type: "compare",
          op: "greater",
          left: { type: "field", field: "close" },
          right: { type: "call", name: "sma", args: [{ type: "field", field: "close" }, { type: "parameter", key: "length" }] },
        },
        then: { type: "field", field: "close" },
        else: { type: "call", name: "sma", args: [{ type: "field", field: "close" }, { type: "parameter", key: "length" }] },
      },
    }],
  };
  const parsed = parseChartIndicatorDsl(JSON.stringify(source));
  assertDsl(parsed.document !== null, "Expected valid DSL document.");
  const candles: ChartCandle[] = [
    candle(1, 10), candle(2, 12), candle(3, 11), candle(4, 15), candle(5, 16),
  ];
  const first = evaluateChartIndicatorDsl(parsed.document, candles);
  const second = evaluateChartIndicatorDsl(parsed.document, candles);
  assertDsl(first.ok && second.ok, "Expected deterministic DSL evaluation.");
  assertDsl(first.operations === second.operations, "Expected stable operation count.");
  assertDsl(JSON.stringify(first.series) === JSON.stringify(second.series), "Expected stable output series.");
  assertDsl(first.series[0]?.points.length === candles.length - 2, "Expected warm-up bars to be omitted.");
  const invalid = parseChartIndicatorDsl({ ...source, outputs: [{ ...source.outputs[0], expression: { type: "call", name: "fetch", args: [] } }] });
  assertDsl(invalid.document === null, "Expected non-whitelisted built-in to be rejected.");
}

function parseJsonInput(input: unknown, diagnostics: DslDiagnostic[]): JsonRecord | null {
  if (typeof input === "string") {
    try {
      const decoded: unknown = JSON.parse(input);
      if (isJsonRecord(decoded)) return decoded;
      diagnostics.push(error("/", "DSL root must be a JSON object."));
      return null;
    } catch {
      diagnostics.push(error("/", "DSL must be valid JSON."));
      return null;
    }
  }
  if (isJsonRecord(input)) return input;
  diagnostics.push(error("/", "DSL root must be a JSON object or JSON string."));
  return null;
}

function parseParameters(value: unknown, diagnostics: DslDiagnostic[]): readonly DslParameterSchema[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("/parameters", "parameters must be an array."));
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((candidate, index) => {
    const path = `/parameters/${index}`;
    if (!isJsonRecord(candidate)) {
      diagnostics.push(error(path, "Parameter must be an object."));
      return [];
    }
    const key = readString(candidate.key, `${path}/key`, diagnostics, 1, 64);
    if (!key || !PARAMETER_KEY.test(key)) diagnostics.push(error(`${path}/key`, "Parameter key must be an identifier."));
    if (key && seen.has(key)) diagnostics.push(error(`${path}/key`, `Duplicate parameter '${key}'.`));
    if (key) seen.add(key);
    const type = candidate.type === "number" || candidate.type === "integer" ? candidate.type : null;
    if (!type) diagnostics.push(error(`${path}/type`, "Parameter type must be number or integer."));
    const defaultValue = readNumber(candidate.defaultValue, `${path}/defaultValue`, diagnostics);
    const min = candidate.min === undefined ? undefined : readNumber(candidate.min, `${path}/min`, diagnostics) ?? undefined;
    const max = candidate.max === undefined ? undefined : readNumber(candidate.max, `${path}/max`, diagnostics) ?? undefined;
    if (min !== undefined && max !== undefined && min > max) diagnostics.push(error(path, "Parameter min cannot exceed max."));
    if (defaultValue !== null && min !== undefined && defaultValue < min) diagnostics.push(error(`${path}/defaultValue`, "Default is below min."));
    if (defaultValue !== null && max !== undefined && defaultValue > max) diagnostics.push(error(`${path}/defaultValue`, "Default is above max."));
    if (type === "integer" && defaultValue !== null && !Number.isInteger(defaultValue)) diagnostics.push(error(`${path}/defaultValue`, "Integer parameter default must be an integer."));
    if (!key || !PARAMETER_KEY.test(key) || !type || defaultValue === null) return [];
    return [{ key, label: optionalString(candidate.label, `${path}/label`, diagnostics, 1, 80), type, defaultValue, min, max }];
  });
}

function parseOutputs(
  value: unknown,
  parameterKeys: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
  budget: ChartIndicatorDslBudget,
): readonly DslOutput[] {
  if (!Array.isArray(value)) {
    diagnostics.push(error("/outputs", "outputs must be an array."));
    return [];
  }
  if (value.length === 0) diagnostics.push(error("/outputs", "At least one output is required."));
  if (value.length > budget.maxOutputs) diagnostics.push(error("/outputs", `At most ${budget.maxOutputs} outputs are allowed.`));
  const seen = new Set<string>();
  return value.flatMap((candidate, index) => {
    const path = `/outputs/${index}`;
    if (!isJsonRecord(candidate)) {
      diagnostics.push(error(path, "Output must be an object."));
      return [];
    }
    const id = readString(candidate.id, `${path}/id`, diagnostics, 1, 64);
    if (!id || !OUTPUT_ID.test(id)) diagnostics.push(error(`${path}/id`, "Output id must be an identifier."));
    if (id && seen.has(id)) diagnostics.push(error(`${path}/id`, `Duplicate output '${id}'.`));
    if (id) seen.add(id);
    const pane = candidate.pane === "main" || candidate.pane === "sub" ? candidate.pane : null;
    if (!pane) diagnostics.push(error(`${path}/pane`, "Output pane must be main or sub."));
    const kind = candidate.kind === "line" || candidate.kind === "histogram" || candidate.kind === "area" ? candidate.kind : null;
    if (!kind) diagnostics.push(error(`${path}/kind`, "Output kind must be line, histogram or area."));
    const expression = parseNumberExpression(candidate.expression, `${path}/expression`, parameterKeys, diagnostics);
    if (!id || !OUTPUT_ID.test(id) || !pane || !kind || !expression) return [];
    return [{ id, label: optionalString(candidate.label, `${path}/label`, diagnostics, 1, 120), pane, kind, color: optionalColor(candidate.color, `${path}/color`, diagnostics), expression }];
  });
}

function parseNumberExpression(value: unknown, path: string, parameterKeys: ReadonlySet<string>, diagnostics: DslDiagnostic[]): DslNumberExpression | null {
  if (!isJsonRecord(value)) {
    diagnostics.push(error(path, "Numeric expression must be an object."));
    return null;
  }
  switch (value.type) {
    case "number": {
      const number = readNumber(value.value, `${path}/value`, diagnostics);
      return number === null ? null : { type: "number", value: number };
    }
    case "field": {
      const field = typeof value.field === "string" && PRICE_FIELDS.has(value.field as DslPriceField) ? value.field as DslPriceField : null;
      if (!field) diagnostics.push(error(`${path}/field`, "Unknown price field."));
      return field ? { type: "field", field } : null;
    }
    case "parameter": {
      const key = readString(value.key, `${path}/key`, diagnostics, 1, 64);
      if (key && !parameterKeys.has(key)) diagnostics.push(error(`${path}/key`, `Unknown parameter '${key}'.`));
      return key && parameterKeys.has(key) ? { type: "parameter", key } : null;
    }
    case "unary": {
      const op = value.op === "negate" || value.op === "absolute" ? value.op : null;
      if (!op) diagnostics.push(error(`${path}/op`, "Unary op must be negate or absolute."));
      const nested = parseNumberExpression(value.value, `${path}/value`, parameterKeys, diagnostics);
      return op && nested ? { type: "unary", op, value: nested } : null;
    }
    case "binary": {
      const op = isBinaryOperator(value.op) ? value.op : null;
      if (!op) diagnostics.push(error(`${path}/op`, "Unknown binary operator."));
      const left = parseNumberExpression(value.left, `${path}/left`, parameterKeys, diagnostics);
      const right = parseNumberExpression(value.right, `${path}/right`, parameterKeys, diagnostics);
      return op && left && right ? { type: "binary", op, left, right } : null;
    }
    case "if": {
      const when = parseBooleanExpression(value.when, `${path}/when`, parameterKeys, diagnostics);
      const then = parseNumberExpression(value.then, `${path}/then`, parameterKeys, diagnostics);
      const otherwise = parseNumberExpression(value.else, `${path}/else`, parameterKeys, diagnostics);
      return when && then && otherwise ? { type: "if", when, then, else: otherwise } : null;
    }
    case "call": {
      const name = typeof value.name === "string" && BUILTIN_NAMES.has(value.name as DslBuiltinName) ? value.name as DslBuiltinName : null;
      if (!name) diagnostics.push(error(`${path}/name`, "Unknown or disallowed built-in."));
      if (!Array.isArray(value.args)) diagnostics.push(error(`${path}/args`, "Built-in args must be an array."));
      const args = Array.isArray(value.args)
        ? value.args.map((argument, index) => parseNumberExpression(argument, `${path}/args/${index}`, parameterKeys, diagnostics)).filter((argument): argument is DslNumberExpression => argument !== null)
        : [];
      if (name && Array.isArray(value.args)) {
        const [minimum, maximum] = BUILTIN_ARITY[name];
        if (value.args.length < minimum || value.args.length > maximum) diagnostics.push(error(`${path}/args`, `${name} expects ${minimum === maximum ? minimum : `${minimum}-${maximum}`} argument(s).`));
        if (args.length !== value.args.length) return null;
      }
      return name && Array.isArray(value.args) ? { type: "call", name, args } : null;
    }
    default:
      diagnostics.push(error(`${path}/type`, "Unknown numeric expression type."));
      return null;
  }
}

function parseBooleanExpression(value: unknown, path: string, parameterKeys: ReadonlySet<string>, diagnostics: DslDiagnostic[]): DslBooleanExpression | null {
  if (!isJsonRecord(value)) {
    diagnostics.push(error(path, "Boolean expression must be an object."));
    return null;
  }
  switch (value.type) {
    case "boolean":
      if (typeof value.value !== "boolean") {
        diagnostics.push(error(`${path}/value`, "Boolean literal value must be true or false."));
        return null;
      }
      return { type: "boolean", value: value.value };
    case "compare": {
      const op = isComparisonOperator(value.op) ? value.op : null;
      if (!op) diagnostics.push(error(`${path}/op`, "Unknown comparison operator."));
      const left = parseNumberExpression(value.left, `${path}/left`, parameterKeys, diagnostics);
      const right = parseNumberExpression(value.right, `${path}/right`, parameterKeys, diagnostics);
      return op && left && right ? { type: "compare", op, left, right } : null;
    }
    case "logical": {
      const op = value.op === "and" || value.op === "or" ? value.op : null;
      if (!op) diagnostics.push(error(`${path}/op`, "Logical op must be and or or."));
      const left = parseBooleanExpression(value.left, `${path}/left`, parameterKeys, diagnostics);
      const right = parseBooleanExpression(value.right, `${path}/right`, parameterKeys, diagnostics);
      return op && left && right ? { type: "logical", op, left, right } : null;
    }
    case "not": {
      const nested = parseBooleanExpression(value.value, `${path}/value`, parameterKeys, diagnostics);
      return nested ? { type: "not", value: nested } : null;
    }
    default:
      diagnostics.push(error(`${path}/type`, "Unknown boolean expression type."));
      return null;
  }
}

function validateTreeResources(
  outputs: readonly DslOutput[],
  parameters: readonly DslParameterSchema[],
  diagnostics: DslDiagnostic[],
  budget: ChartIndicatorDslBudget,
): void {
  if (parameters.length > 32) diagnostics.push(error("/parameters", "At most 32 parameters are allowed."));
  let nodes = 0;
  const visitNumber = (expression: DslNumberExpression, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > budget.maxNodes) diagnostics.push(error(path, `DSL exceeds ${budget.maxNodes} AST nodes.`));
    if (depth > budget.maxDepth) diagnostics.push(error(path, `DSL exceeds maximum depth ${budget.maxDepth}.`));
    if (expression.type === "unary") visitNumber(expression.value, `${path}/value`, depth + 1);
    if (expression.type === "binary") {
      visitNumber(expression.left, `${path}/left`, depth + 1);
      visitNumber(expression.right, `${path}/right`, depth + 1);
    }
    if (expression.type === "if") {
      visitBoolean(expression.when, `${path}/when`, depth + 1);
      visitNumber(expression.then, `${path}/then`, depth + 1);
      visitNumber(expression.else, `${path}/else`, depth + 1);
    }
    if (expression.type === "call") {
      expression.args.forEach((argument, index) => visitNumber(argument, `${path}/args/${index}`, depth + 1));
      validateBuiltinLookback(expression, path, parameters, diagnostics, budget);
    }
  };
  const visitBoolean = (expression: DslBooleanExpression, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > budget.maxNodes) diagnostics.push(error(path, `DSL exceeds ${budget.maxNodes} AST nodes.`));
    if (depth > budget.maxDepth) diagnostics.push(error(path, `DSL exceeds maximum depth ${budget.maxDepth}.`));
    if (expression.type === "compare") {
      visitNumber(expression.left, `${path}/left`, depth + 1);
      visitNumber(expression.right, `${path}/right`, depth + 1);
    }
    if (expression.type === "logical") {
      visitBoolean(expression.left, `${path}/left`, depth + 1);
      visitBoolean(expression.right, `${path}/right`, depth + 1);
    }
    if (expression.type === "not") visitBoolean(expression.value, `${path}/value`, depth + 1);
  };
  outputs.forEach((output, index) => visitNumber(output.expression, `/outputs/${index}/expression`, 1));
}

function validateBuiltinLookback(
  expression: Extract<DslNumberExpression, { type: "call" }>,
  path: string,
  parameters: readonly DslParameterSchema[],
  diagnostics: DslDiagnostic[],
  budget: ChartIndicatorDslBudget,
): void {
  const periodArgument = expression.name === "sma" || expression.name === "ema" || expression.name === "highest" || expression.name === "lowest" || expression.name === "stddev"
    ? expression.args[1]
    : expression.name === "rsi" || expression.name === "atr" ? expression.args[0] : undefined;
  if (!periodArgument) return;
  const bound = staticPeriodUpperBound(periodArgument, parameters);
  if (bound === null) {
    diagnostics.push(error(path, "Lookback must be a numeric literal or a bounded parameter."));
  } else if (!Number.isInteger(bound) || bound < 1 || bound > budget.maxLookback) {
    diagnostics.push(error(path, `Lookback must be an integer between 1 and ${budget.maxLookback}.`));
  }
}

function staticPeriodUpperBound(expression: DslNumberExpression, parameters: readonly DslParameterSchema[]): number | null {
  if (expression.type === "number") return expression.value;
  if (expression.type !== "parameter") return null;
  const parameter = parameters.find((candidate) => candidate.key === expression.key);
  return parameter?.max ?? null;
}

class DslEvaluator {
  private readonly numberCache = new WeakMap<object, Map<number, number | undefined>>();
  private readonly booleanCache = new WeakMap<object, Map<number, boolean | undefined>>();
  private operationCount = 0;

  constructor(
    private readonly candles: readonly ChartCandle[],
    private readonly parameters: Readonly<Record<string, number>>,
    private readonly budget: ChartIndicatorDslBudget,
    private readonly diagnostics: DslDiagnostic[],
  ) {}

  get operations(): number {
    return this.operationCount;
  }

  evaluateOutput(output: DslOutput): readonly ChartIndicatorDslPoint[] {
    const points: ChartIndicatorDslPoint[] = [];
    for (let index = 0; index < this.candles.length; index += 1) {
      const value = this.number(output.expression, index);
      if (value !== undefined && Number.isFinite(value)) points.push({ time: this.candles[index].time, value });
      if (this.failed()) break;
    }
    return points;
  }

  readNumberExpression(expression: DslNumberExpression, index: number): number | undefined {
    return this.number(expression, index);
  }

  private number(expression: DslNumberExpression, index: number): number | undefined {
    const cached = this.readCache(this.numberCache, expression, index);
    if (cached.hit) return cached.value;
    const value = this.calculateNumber(expression, index);
    this.writeCache(this.numberCache, expression, index, value);
    return value;
  }

  private boolean(expression: DslBooleanExpression, index: number): boolean | undefined {
    const cached = this.readCache(this.booleanCache, expression, index);
    if (cached.hit) return cached.value;
    const value = this.calculateBoolean(expression, index);
    this.writeCache(this.booleanCache, expression, index, value);
    return value;
  }

  private calculateNumber(expression: DslNumberExpression, index: number): number | undefined {
    if (!this.charge()) return undefined;
    switch (expression.type) {
      case "number": return expression.value;
      case "field": return fieldValue(this.candles[index], expression.field);
      case "parameter": return this.parameters[expression.key];
      case "unary": {
        const value = this.number(expression.value, index);
        return value === undefined ? undefined : expression.op === "negate" ? -value : Math.abs(value);
      }
      case "binary": return this.binary(expression, index);
      case "if": {
        const condition = this.boolean(expression.when, index);
        return condition === undefined ? undefined : this.number(condition ? expression.then : expression.else, index);
      }
      case "call": return this.call(expression, index);
    }
  }

  private calculateBoolean(expression: DslBooleanExpression, index: number): boolean | undefined {
    if (!this.charge()) return undefined;
    switch (expression.type) {
      case "boolean": return expression.value;
      case "compare": {
        const left = this.number(expression.left, index);
        const right = this.number(expression.right, index);
        if (left === undefined || right === undefined) return undefined;
        return compare(left, right, expression.op);
      }
      case "logical": {
        const left = this.boolean(expression.left, index);
        if (left === undefined) return undefined;
        if (expression.op === "and" && !left) return false;
        if (expression.op === "or" && left) return true;
        const right = this.boolean(expression.right, index);
        return right === undefined ? undefined : right;
      }
      case "not": {
        const value = this.boolean(expression.value, index);
        return value === undefined ? undefined : !value;
      }
    }
  }

  private binary(expression: Extract<DslNumberExpression, { type: "binary" }>, index: number): number | undefined {
    const left = this.number(expression.left, index);
    const right = this.number(expression.right, index);
    if (left === undefined || right === undefined) return undefined;
    if (expression.op === "add") return left + right;
    if (expression.op === "subtract") return left - right;
    if (expression.op === "multiply") return left * right;
    if (expression.op === "divide") return right === 0 ? undefined : left / right;
    if (expression.op === "modulo") return right === 0 ? undefined : left % right;
    return Number.isFinite(left ** right) ? left ** right : undefined;
  }

  private call(expression: Extract<DslNumberExpression, { type: "call" }>, index: number): number | undefined {
    switch (expression.name) {
      case "abs": return mapNumber(this.number(expression.args[0], index), Math.abs);
      case "min": return combine(this.number(expression.args[0], index), this.number(expression.args[1], index), Math.min);
      case "max": return combine(this.number(expression.args[0], index), this.number(expression.args[1], index), Math.max);
      case "sma": return this.window(expression.args[0], periodAt(this, expression.args[1], index), index, (values) => mean(values));
      case "ema": return this.ema(expression, expression.args[0], periodAt(this, expression.args[1], index), index);
      case "rsi": return this.rsi(periodAt(this, expression.args[0], index), index);
      case "atr": return this.atr(periodAt(this, expression.args[0], index), index);
      case "vwap": return this.vwap(index);
      case "highest": return this.window(expression.args[0], periodAt(this, expression.args[1], index), index, (values) => Math.max(...values));
      case "lowest": return this.window(expression.args[0], periodAt(this, expression.args[1], index), index, (values) => Math.min(...values));
      case "stddev": return this.window(expression.args[0], periodAt(this, expression.args[1], index), index, (values) => standardDeviation(values));
    }
  }

  private window(
    source: DslNumberExpression,
    period: number | undefined,
    index: number,
    aggregate: (values: readonly number[]) => number,
  ): number | undefined {
    if (!period || index < period - 1) return undefined;
    const values: number[] = [];
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      if (!this.charge()) return undefined;
      const value = this.number(source, cursor);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return aggregate(values);
  }

  private ema(
    expression: Extract<DslNumberExpression, { type: "call" }>,
    source: DslNumberExpression,
    period: number | undefined,
    index: number,
  ): number | undefined {
    if (!period || index < period - 1) return undefined;
    if (index === period - 1) return this.window(source, period, index, (values) => mean(values));
    const previous = this.number(expression, index - 1);
    const value = this.number(source, index);
    return previous === undefined || value === undefined ? undefined : previous + (value - previous) * (2 / (period + 1));
  }

  private rsi(period: number | undefined, index: number): number | undefined {
    if (!period || index < period) return undefined;
    let gains = 0;
    let losses = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      if (!this.charge()) return undefined;
      const change = this.candles[cursor].close - this.candles[cursor - 1].close;
      gains += Math.max(change, 0);
      losses += Math.max(-change, 0);
    }
    if (losses === 0) return gains === 0 ? 50 : 100;
    return 100 - 100 / (1 + gains / losses);
  }

  private atr(period: number | undefined, index: number): number | undefined {
    if (!period || index < period) return undefined;
    let sum = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      if (!this.charge()) return undefined;
      const candle = this.candles[cursor];
      const previousClose = this.candles[cursor - 1].close;
      sum += Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
    }
    return sum / period;
  }

  private vwap(index: number): number | undefined {
    let volume = 0;
    let weighted = 0;
    for (let cursor = 0; cursor <= index; cursor += 1) {
      if (!this.charge()) return undefined;
      const candle = this.candles[cursor];
      volume += candle.volume;
      weighted += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    }
    return volume > 0 ? weighted / volume : undefined;
  }

  private charge(): boolean {
    this.operationCount += 1;
    if (this.operationCount <= this.budget.maxOperations) return true;
    if (!this.failed()) this.diagnostics.push(error("/", `DSL exceeded operation budget (${this.budget.maxOperations}).`));
    return false;
  }

  private failed(): boolean {
    return this.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  }

  private readCache<T>(cache: WeakMap<object, Map<number, T>>, expression: object, index: number): Readonly<{ hit: true; value: T }> | Readonly<{ hit: false }> {
    const values = cache.get(expression);
    if (!values || !values.has(index)) return { hit: false };
    return { hit: true, value: values.get(index) as T };
  }

  private writeCache<T>(cache: WeakMap<object, Map<number, T>>, expression: object, index: number, value: T): void {
    let values = cache.get(expression);
    if (!values) {
      values = new Map<number, T>();
      cache.set(expression, values);
    }
    values.set(index, value);
  }
}

function resolveBudget(overrides: Partial<ChartIndicatorDslBudget>): ChartIndicatorDslBudget {
  const budget = { ...DEFAULT_CHART_INDICATOR_DSL_BUDGET, ...overrides };
  return {
    maxNodes: boundedInteger(budget.maxNodes, 1, 5_000, DEFAULT_CHART_INDICATOR_DSL_BUDGET.maxNodes),
    maxDepth: boundedInteger(budget.maxDepth, 1, 128, DEFAULT_CHART_INDICATOR_DSL_BUDGET.maxDepth),
    maxLookback: boundedInteger(budget.maxLookback, 1, 10_000, DEFAULT_CHART_INDICATOR_DSL_BUDGET.maxLookback),
    maxOutputs: boundedInteger(budget.maxOutputs, 1, 128, DEFAULT_CHART_INDICATOR_DSL_BUDGET.maxOutputs),
    maxBars: boundedInteger(budget.maxBars, 1, 100_000, DEFAULT_CHART_INDICATOR_DSL_BUDGET.maxBars),
    maxOperations: boundedInteger(budget.maxOperations, 100, 100_000_000, DEFAULT_CHART_INDICATOR_DSL_BUDGET.maxOperations),
  };
}

function normalizeCandles(candles: readonly ChartCandle[], budget: ChartIndicatorDslBudget, diagnostics: DslDiagnostic[]): readonly ChartCandle[] {
  if (candles.length > budget.maxBars) {
    diagnostics.push(error("/candles", `At most ${budget.maxBars} bars may be evaluated.`));
    return [];
  }
  const normalized: ChartCandle[] = [];
  let previousTime = -Infinity;
  candles.forEach((candle, index) => {
    const fields = [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume];
    if (!fields.every(Number.isFinite) || candle.high < candle.low || candle.volume < 0) {
      diagnostics.push(error(`/candles/${index}`, "Candle must contain finite OHLCV values."));
      return;
    }
    if (candle.time <= previousTime) diagnostics.push(error(`/candles/${index}/time`, "Candles must be strictly time-ordered."));
    previousTime = candle.time;
    normalized.push(candle);
  });
  return normalized;
}

function resolveParameters(
  schemas: readonly DslParameterSchema[],
  supplied: Readonly<Record<string, number>>,
  diagnostics: DslDiagnostic[],
): Readonly<Record<string, number>> {
  const values: Record<string, number> = {};
  for (const schema of schemas) {
    const value = supplied[schema.key] ?? schema.defaultValue;
    if (!Number.isFinite(value)) {
      diagnostics.push(error(`/parameters/${schema.key}`, "Parameter must be finite."));
      continue;
    }
    if (schema.type === "integer" && !Number.isInteger(value)) diagnostics.push(error(`/parameters/${schema.key}`, "Parameter must be an integer."));
    if (schema.min !== undefined && value < schema.min) diagnostics.push(error(`/parameters/${schema.key}`, `Parameter must be at least ${schema.min}.`));
    if (schema.max !== undefined && value > schema.max) diagnostics.push(error(`/parameters/${schema.key}`, `Parameter must be at most ${schema.max}.`));
    values[schema.key] = value;
  }
  return values;
}

function periodAt(evaluator: DslEvaluator, expression: DslNumberExpression | undefined, index: number): number | undefined {
  if (!expression) return undefined;
  const value = evaluator.readNumberExpression(expression, index);
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function fieldValue(candle: ChartCandle | undefined, field: DslPriceField): number | undefined {
  if (!candle) return undefined;
  if (field === "hl2") return (candle.high + candle.low) / 2;
  if (field === "hlc3") return (candle.high + candle.low + candle.close) / 3;
  if (field === "ohlc4") return (candle.open + candle.high + candle.low + candle.close) / 4;
  return candle[field];
}

function compare(left: number, right: number, op: DslComparisonOperator): boolean {
  if (op === "greater") return left > right;
  if (op === "greaterEqual") return left >= right;
  if (op === "less") return left < right;
  if (op === "lessEqual") return left <= right;
  if (op === "equal") return left === right;
  return left !== right;
}

function isBinaryOperator(value: unknown): value is DslBinaryOperator {
  return value === "add" || value === "subtract" || value === "multiply" || value === "divide" || value === "modulo" || value === "power";
}

function isComparisonOperator(value: unknown): value is DslComparisonOperator {
  return value === "greater" || value === "greaterEqual" || value === "less" || value === "lessEqual" || value === "equal" || value === "notEqual";
}

function readNumber(value: unknown, path: string, diagnostics: DslDiagnostic[]): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    diagnostics.push(error(path, "Value must be a finite number."));
    return null;
  }
  return value;
}

function readString(value: unknown, path: string, diagnostics: DslDiagnostic[], minLength: number, maxLength: number): string | null {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
    diagnostics.push(error(path, `Value must be a string between ${minLength} and ${maxLength} characters.`));
    return null;
  }
  return value;
}

function optionalString(value: unknown, path: string, diagnostics: DslDiagnostic[], minLength: number, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, path, diagnostics, minLength, maxLength) ?? undefined;
}

function optionalColor(value: unknown, path: string, diagnostics: DslDiagnostic[]): string | undefined {
  if (value === undefined) return undefined;
  const color = readString(value, path, diagnostics, 1, 32);
  if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) diagnostics.push(error(path, "Color must be a hexadecimal CSS color."));
  return color ?? undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(path: string, message: string): DslDiagnostic {
  return { severity: "error", path, message };
}

function mapNumber(value: number | undefined, mapper: (value: number) => number): number | undefined {
  return value === undefined ? undefined : mapper(value);
}

function combine(left: number | undefined, right: number | undefined, mapper: (left: number, right: number) => number): number | undefined {
  return left === undefined || right === undefined ? undefined : mapper(left, right);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function candle(time: number, close: number): ChartCandle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

function assertDsl(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Chart indicator DSL smoke assertion failed: ${message}`);
}

type JsonRecord = Readonly<Record<string, unknown>>;
