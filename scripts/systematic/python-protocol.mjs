import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PYTHON_STRATEGY_PROTOCOL = "desic.systematic.python/v1";
export const MAX_STRATEGY_SOURCE_BYTES = 256 * 1024;
export const MAX_JSONL_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_STRATEGY_PARAMETER_BYTES = 32 * 1024;

const ALLOWED_IMPORT_ROOTS = new Set([
  "collections",
  "dataclasses",
  "math",
  "numpy",
  "pandas",
  "sklearn",
  "statistics",
  "typing"
]);

const FORBIDDEN_IMPORT_ROOTS = new Set([
  "aiohttp",
  "asyncio",
  "builtins",
  "ctypes",
  "fileinput",
  "ftplib",
  "glob",
  "http",
  "importlib",
  "io",
  "multiprocessing",
  "os",
  "pathlib",
  "pickle",
  "pty",
  "requests",
  "runpy",
  "shutil",
  "signal",
  "socket",
  "smtplib",
  "ssl",
  "subprocess",
  "sys",
  "tempfile",
  "telnetlib",
  "urllib",
  "webbrowser",
  "websockets"
]);

const FORBIDDEN_CALLS = [
  "breakpoint",
  "compile",
  "delattr",
  "dir",
  "eval",
  "exec",
  "getattr",
  "globals",
  "help",
  "input",
  "locals",
  "open",
  "setattr",
  "vars",
  "__import__"
];

const TIMESTAMP_FIELDS = new Set([
  "asOfMs",
  "createdAtMs",
  "closedAtMs",
  "closeTimeMs",
  "completedAtMs",
  "filledAtMs",
  "lastUpdatedMs",
  "observedAtMs",
  "openedAtMs",
  "openTimeMs",
  "publishedAtMs",
  "timestampMs",
  "tsMs",
  "updatedAtMs"
]);

const BAR_INTERVAL_PATTERN = /^[1-9]\d*(?:m|H|D|W)$/;
const INSTRUMENT_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,62}[A-Z0-9]$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRATEGY_ACTIONS = new Set(["open_long", "open_short", "close_long", "close_short", "set_protection", "cancel_protection", "cancel_order"]);
const POSITION_SIDES = new Set(["long", "short"]);
const ORDER_STATUSES = new Set(["open", "partially_filled"]);
const ORDER_TYPES = new Set(["market", "limit"]);

export class PythonStrategyProtocolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PythonStrategyProtocolError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PythonStrategyProtocolError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectPlainObject(value, label) {
  if (!isPlainObject(value)) fail("invalid_shape", `${label} must be an object`);
  return value;
}

function expectString(value, label, { min = 1, max = 4096, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail("invalid_shape", `${label} must be a string between ${min} and ${max} characters`);
  }
  if (pattern && !pattern.test(value)) fail("invalid_shape", `${label} has an invalid format`);
  return value;
}

function expectPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("invalid_shape", `${label} must be a positive safe integer`);
  }
  return value;
}

function expectFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_shape", `${label} must be a finite number`);
  }
  return value;
}

function expectProtocolEnvelope(message, expectedType) {
  const value = expectPlainObject(message, "message");
  if (value.protocol !== PYTHON_STRATEGY_PROTOCOL) {
    fail("protocol_mismatch", `message.protocol must be ${PYTHON_STRATEGY_PROTOCOL}`);
  }
  if (expectedType && value.type !== expectedType) {
    fail("invalid_message_type", `message.type must be ${expectedType}`);
  }
  return value;
}

function ensureJsonValue(value, label = "value", depth = 0) {
  if (depth > 12) fail("invalid_shape", `${label} exceeds the maximum JSON nesting depth`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    expectFiniteNumber(value, label);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2_000) fail("invalid_shape", `${label} exceeds the maximum array length`);
    value.forEach((item, index) => ensureJsonValue(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > 200) fail("invalid_shape", `${label} exceeds the maximum object size`);
    for (const [key, child] of entries) {
      expectString(key, `${label} key`, { max: 128 });
      ensureJsonValue(child, `${label}.${key}`, depth + 1);
    }
    return;
  }
  fail("invalid_shape", `${label} must be JSON-serializable`);
}

export function validateStrategyParameters(parameters) {
  const value = expectPlainObject(parameters, "strategy parameters");
  ensureJsonValue(value, "strategy parameters");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_STRATEGY_PARAMETER_BYTES) {
    fail("invalid_shape", `strategy parameters exceed the ${MAX_STRATEGY_PARAMETER_BYTES}-byte limit`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unknown_field", `${label}.${key} is not part of the protocol`);
  }
}

function assertNoFutureTimestamp(value, cutoffMs, label = "event", depth = 0) {
  if (depth > 16 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoFutureTimestamp(child, cutoffMs, `${label}[${index}]`, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (TIMESTAMP_FIELDS.has(key)) {
      expectPositiveSafeInteger(child, `${label}.${key}`);
      const partialBarClose = key === "closeTimeMs" && value.confirmed === false;
      if (child > cutoffMs && !partialBarClose) {
        fail("future_data", `${label}.${key} is later than event.asOfMs`);
      }
    }
    assertNoFutureTimestamp(child, cutoffMs, `${label}.${key}`, depth + 1);
  }
}

function validateBar(bar, cutoffMs, label) {
  const value = expectPlainObject(bar, label);
  rejectUnknownFields(value, new Set(["openTimeMs", "closeTimeMs", "open", "high", "low", "close", "volume", "confirmed"]), label);
  const openTimeMs = expectPositiveSafeInteger(value.openTimeMs, `${label}.openTimeMs`);
  const closeTimeMs = expectPositiveSafeInteger(value.closeTimeMs, `${label}.closeTimeMs`);
  if (openTimeMs >= closeTimeMs) fail("invalid_bar", `${label} must open before it closes`);
  if (typeof value.confirmed !== "boolean") fail("invalid_bar", `${label}.confirmed must be boolean`);
  if (value.confirmed && closeTimeMs > cutoffMs) fail("future_data", `${label}.closeTimeMs is later than event.asOfMs`);
  if (!value.confirmed && (openTimeMs >= cutoffMs || closeTimeMs <= cutoffMs)) {
    fail("invalid_bar", `${label} must be the active in-progress bucket`);
  }
  for (const field of ["open", "high", "low", "close", "volume"]) {
    expectFiniteNumber(value[field], `${label}.${field}`);
  }
  if (value.high < Math.max(value.open, value.close) || value.low > Math.min(value.open, value.close) || value.high < value.low) {
    fail("invalid_bar", `${label} has invalid OHLC values`);
  }
}

function validateSeries(series, cutoffMs, label) {
  const value = expectPlainObject(series, label);
  rejectUnknownFields(value, new Set(["instrumentId", "interval", "bars"]), label);
  expectString(value.instrumentId, `${label}.instrumentId`, { max: 64, pattern: INSTRUMENT_ID_PATTERN });
  expectString(value.interval, `${label}.interval`, { max: 12, pattern: BAR_INTERVAL_PATTERN });
  if (!Array.isArray(value.bars) || value.bars.length === 0 || value.bars.length > 20_000) {
    fail("invalid_series", `${label}.bars must contain 1 to 20000 closed bars`);
  }
  let previousClose = 0;
  value.bars.forEach((bar, index) => {
    validateBar(bar, cutoffMs, `${label}.bars[${index}]`);
    if (bar.closeTimeMs <= previousClose) fail("invalid_series", `${label}.bars must be strictly chronological`);
    if (bar.confirmed === false && index !== value.bars.length - 1) {
      fail("invalid_series", `${label} may contain an unconfirmed bar only at the end`);
    }
    previousClose = bar.closeTimeMs;
  });
}

function validateMarket(market, cutoffMs) {
  const value = expectPlainObject(market, "event.market");
  rejectUnknownFields(value, new Set(["series"]), "event.market");
  if (!Array.isArray(value.series) || value.series.length === 0 || value.series.length > 256) {
    fail("invalid_market", "event.market.series must contain 1 to 256 series");
  }
  const seriesKeys = new Set();
  value.series.forEach((series, index) => {
    validateSeries(series, cutoffMs, `event.market.series[${index}]`);
    const key = `${series.instrumentId}|${series.interval}`;
    if (seriesKeys.has(key)) fail("invalid_market", `event.market.series contains duplicate ${key}`);
    seriesKeys.add(key);
  });
  assertNoFutureTimestamp(value, cutoffMs, "event.market");
}

function expectNonNegativeFiniteNumber(value, label) {
  const number = expectFiniteNumber(value, label);
  if (number < 0) fail("invalid_shape", `${label} must be zero or greater`);
  return number;
}

function expectPositiveFiniteNumber(value, label) {
  const number = expectFiniteNumber(value, label);
  if (number <= 0) fail("invalid_shape", `${label} must be greater than zero`);
  return number;
}

function validateOptionalPositivePrice(value, label) {
  if (value !== undefined) expectPositiveFiniteNumber(value, label);
}

function validatePortfolioPosition(position, cutoffMs, label) {
  const value = expectPlainObject(position, label);
  rejectUnknownFields(
    value,
    new Set([
      "instrumentId",
      "side",
      "quantity",
      "averageEntryPrice",
      "markPrice",
      "contractValue",
      "notionalUsdt",
      "usedMarginUsdt",
      "leverage",
      "marginSafetyMultiplier",
      "unrealizedPnlUsdt",
      "entryFeeUsdt",
      "fundingCashflowUsdt",
      "stopLossPrice",
      "takeProfitPrice",
      "openedAtMs",
      "updatedAtMs"
    ]),
    label
  );
  expectString(value.instrumentId, `${label}.instrumentId`, { max: 64, pattern: INSTRUMENT_ID_PATTERN });
  if (!POSITION_SIDES.has(value.side)) fail("invalid_shape", `${label}.side must be long or short`);
  expectPositiveFiniteNumber(value.quantity, `${label}.quantity`);
  for (const field of ["averageEntryPrice", "markPrice", "contractValue", "notionalUsdt", "usedMarginUsdt", "leverage", "marginSafetyMultiplier"]) {
    validateOptionalPositivePrice(value[field], `${label}.${field}`);
  }
  for (const field of ["stopLossPrice", "takeProfitPrice"]) {
    if (value[field] !== undefined && value[field] !== null) expectPositiveFiniteNumber(value[field], `${label}.${field}`);
  }
  for (const field of ["unrealizedPnlUsdt", "entryFeeUsdt", "fundingCashflowUsdt"]) {
    if (value[field] !== undefined) expectFiniteNumber(value[field], `${label}.${field}`);
  }
  if (value.openedAtMs !== undefined) expectPositiveSafeInteger(value.openedAtMs, `${label}.openedAtMs`);
  if (value.updatedAtMs !== undefined) expectPositiveSafeInteger(value.updatedAtMs, `${label}.updatedAtMs`);
  if (value.openedAtMs !== undefined && value.updatedAtMs !== undefined && value.updatedAtMs < value.openedAtMs) {
    fail("invalid_shape", `${label}.updatedAtMs must not precede openedAtMs`);
  }
  assertNoFutureTimestamp(value, cutoffMs, label);
}

function validatePortfolioOrder(order, cutoffMs, label) {
  const value = expectPlainObject(order, label);
  rejectUnknownFields(
    value,
    new Set([
      "id",
      "instrumentId",
      "action",
      "quantity",
      "filledQuantity",
      "status",
      "createdAtMs",
      "price",
      "triggerPrice"
    ]),
    label
  );
  expectString(value.id, `${label}.id`, { max: 128, pattern: REQUEST_ID_PATTERN });
  expectString(value.instrumentId, `${label}.instrumentId`, { max: 64, pattern: INSTRUMENT_ID_PATTERN });
  if (!STRATEGY_ACTIONS.has(value.action)) fail("invalid_shape", `${label}.action is invalid`);
  const quantity = expectPositiveFiniteNumber(value.quantity, `${label}.quantity`);
  const filledQuantity = expectNonNegativeFiniteNumber(value.filledQuantity, `${label}.filledQuantity`);
  if (filledQuantity >= quantity) fail("invalid_shape", `${label}.filledQuantity must be lower than quantity for an open order`);
  if (!ORDER_STATUSES.has(value.status)) fail("invalid_shape", `${label}.status must be open or partially_filled`);
  expectPositiveSafeInteger(value.createdAtMs, `${label}.createdAtMs`);
  validateOptionalPositivePrice(value.price, `${label}.price`);
  validateOptionalPositivePrice(value.triggerPrice, `${label}.triggerPrice`);
  assertNoFutureTimestamp(value, cutoffMs, label);
}

function validatePortfolioFill(fill, cutoffMs, label) {
  const value = expectPlainObject(fill, label);
  rejectUnknownFields(
    value,
    new Set(["id", "orderId", "instrumentId", "action", "quantity", "price", "notionalUsdt", "filledAtMs", "feeUsdt", "marginDeltaUsdt", "marginAfterUsdt"]),
    label
  );
  expectString(value.id, `${label}.id`, { max: 128, pattern: REQUEST_ID_PATTERN });
  expectString(value.orderId, `${label}.orderId`, { max: 128, pattern: REQUEST_ID_PATTERN });
  expectString(value.instrumentId, `${label}.instrumentId`, { max: 64, pattern: INSTRUMENT_ID_PATTERN });
  if (!STRATEGY_ACTIONS.has(value.action)) fail("invalid_shape", `${label}.action is invalid`);
  expectPositiveFiniteNumber(value.quantity, `${label}.quantity`);
  expectPositiveFiniteNumber(value.price, `${label}.price`);
  expectPositiveSafeInteger(value.filledAtMs, `${label}.filledAtMs`);
  if (value.feeUsdt !== undefined) expectNonNegativeFiniteNumber(value.feeUsdt, `${label}.feeUsdt`);
  if (value.notionalUsdt !== undefined) expectPositiveFiniteNumber(value.notionalUsdt, `${label}.notionalUsdt`);
  if (value.marginDeltaUsdt !== undefined) expectFiniteNumber(value.marginDeltaUsdt, `${label}.marginDeltaUsdt`);
  if (value.marginAfterUsdt !== undefined) expectNonNegativeFiniteNumber(value.marginAfterUsdt, `${label}.marginAfterUsdt`);
  assertNoFutureTimestamp(value, cutoffMs, label);
}

function validatePortfolioTrade(trade, cutoffMs, label) {
  const value = expectPlainObject(trade, label);
  rejectUnknownFields(
    value,
    new Set([
      "id",
      "instrumentId",
      "side",
      "quantity",
      "entryPrice",
      "exitPrice",
      "entryNotionalUsdt",
      "exitNotionalUsdt",
      "usedMarginUsdt",
      "leverage",
      "marginSafetyMultiplier",
      "openedAtMs",
      "closedAtMs",
      "realizedPnlUsdt",
      "feesUsdt"
    ]),
    label
  );
  expectString(value.id, `${label}.id`, { max: 128, pattern: REQUEST_ID_PATTERN });
  expectString(value.instrumentId, `${label}.instrumentId`, { max: 64, pattern: INSTRUMENT_ID_PATTERN });
  if (!POSITION_SIDES.has(value.side)) fail("invalid_shape", `${label}.side must be long or short`);
  expectPositiveFiniteNumber(value.quantity, `${label}.quantity`);
  expectPositiveFiniteNumber(value.entryPrice, `${label}.entryPrice`);
  expectPositiveFiniteNumber(value.exitPrice, `${label}.exitPrice`);
  expectPositiveSafeInteger(value.openedAtMs, `${label}.openedAtMs`);
  expectPositiveSafeInteger(value.closedAtMs, `${label}.closedAtMs`);
  if (value.closedAtMs < value.openedAtMs) fail("invalid_shape", `${label}.closedAtMs must not precede openedAtMs`);
  if (value.realizedPnlUsdt !== undefined) expectFiniteNumber(value.realizedPnlUsdt, `${label}.realizedPnlUsdt`);
  if (value.feesUsdt !== undefined) expectNonNegativeFiniteNumber(value.feesUsdt, `${label}.feesUsdt`);
  for (const field of ["entryNotionalUsdt", "exitNotionalUsdt", "usedMarginUsdt", "leverage", "marginSafetyMultiplier"]) {
    if (value[field] !== undefined) expectPositiveFiniteNumber(value[field], `${label}.${field}`);
  }
  assertNoFutureTimestamp(value, cutoffMs, label);
}

function validateUniqueRows(rows, label, keyForRow) {
  const ids = new Set();
  rows.forEach((row, index) => {
    const key = keyForRow(row);
    if (ids.has(key)) fail("invalid_shape", `${label} contains duplicate ${key}`);
    ids.add(key);
  });
}

function validatePortfolio(portfolio, cutoffMs) {
  // The trusted compatibility fixture predates virtual-account snapshots. Omitting
  // portfolio is retained only for that legacy input; all managed strategy hosts
  // must supply the full simulated snapshot described by this protocol.
  if (portfolio === undefined) return;
  const value = expectPlainObject(portfolio, "event.portfolio");
  rejectUnknownFields(
    value,
    new Set(["cashUsdt", "equityUsdt", "usedMarginUsdt", "availableMarginUsdt", "positions", "openOrders", "recentFills", "trades", "ledgerMode"]),
    "event.portfolio"
  );
  if (value.ledgerMode !== undefined && value.ledgerMode !== "replace" && value.ledgerMode !== "append") {
    fail("invalid_portfolio", "event.portfolio.ledgerMode must be replace or append");
  }
  expectNonNegativeFiniteNumber(value.cashUsdt, "event.portfolio.cashUsdt");
  expectNonNegativeFiniteNumber(value.equityUsdt, "event.portfolio.equityUsdt");
  expectNonNegativeFiniteNumber(value.usedMarginUsdt ?? 0, "event.portfolio.usedMarginUsdt");
  expectNonNegativeFiniteNumber(value.availableMarginUsdt, "event.portfolio.availableMarginUsdt");
  if (value.availableMarginUsdt > value.equityUsdt) {
    fail("invalid_shape", "event.portfolio.availableMarginUsdt must not exceed equityUsdt");
  }
  if ((value.usedMarginUsdt ?? 0) + value.availableMarginUsdt > value.equityUsdt + 1e-8) {
    fail("invalid_shape", "event.portfolio.usedMarginUsdt plus availableMarginUsdt must not exceed equityUsdt");
  }
  const collections = [
    ["positions", 512, validatePortfolioPosition],
    ["openOrders", 2_000, validatePortfolioOrder],
    ["recentFills", 5_000, validatePortfolioFill],
    ["trades", 10_000, validatePortfolioTrade]
  ];
  for (const [field, maximum, validator] of collections) {
    const rows = value[field];
    if (!Array.isArray(rows) || rows.length > maximum) {
      fail("invalid_shape", `event.portfolio.${field} must contain 0 to ${maximum} rows`);
    }
    rows.forEach((row, index) => validator(row, cutoffMs, `event.portfolio.${field}[${index}]`));
  }
  validateUniqueRows(value.positions, "event.portfolio.positions", (row) => `${row.instrumentId}|${row.side}`);
  validateUniqueRows(value.openOrders, "event.portfolio.openOrders", (row) => row.id);
  validateUniqueRows(value.recentFills, "event.portfolio.recentFills", (row) => row.id);
  validateUniqueRows(value.trades, "event.portfolio.trades", (row) => row.id);
}

function validateActiveInstrumentEvent(event, cutoffMs, kind) {
  expectString(event.instrumentId, "event.instrumentId", { max: 64, pattern: INSTRUMENT_ID_PATTERN });
  expectString(event.interval, "event.interval", { max: 12, pattern: BAR_INTERVAL_PATTERN });
  const matchingSeries = event.market.series.find(
    (series) => series.instrumentId === event.instrumentId && series.interval === event.interval
  );
  if (!matchingSeries) {
    fail("invalid_event", `${kind} events must include the active instrument series in event.market.series`);
  }
  if (kind === "bar") {
    validateBar(event.bar, cutoffMs, "event.bar");
    if (event.bar.closeTimeMs !== cutoffMs) {
      fail("invalid_event", "bar event.bar.closeTimeMs must exactly equal event.asOfMs");
    }
    const latestBar = matchingSeries.bars.at(-1);
    if (latestBar.closeTimeMs !== event.bar.closeTimeMs) {
      fail("invalid_event", "bar event.bar must be the latest active series bar");
    }
  }
  return matchingSeries;
}

function eligibleUniverseInstrumentIds(event) {
  return new Set(event.universe.filter((row) => row.eligible !== false).map((row) => row.instrumentId));
}

export function validateInvokeRequest(message) {
  const value = expectProtocolEnvelope(message, "invoke");
  expectString(value.requestId, "message.requestId", { max: 128, pattern: REQUEST_ID_PATTERN });
  const event = expectPlainObject(value.event, "message.event");
  const asOfMs = expectPositiveSafeInteger(event.asOfMs, "event.asOfMs");
  if (!["start", "bar", "rebalance"].includes(event.kind)) {
    fail("invalid_event_kind", "event.kind must be start, bar, or rebalance");
  }
  expectString(event.snapshotId, "event.snapshotId", { max: 128, pattern: REQUEST_ID_PATTERN });
  validateMarket(event.market, asOfMs);
  validatePortfolio(event.portfolio, asOfMs);

  if (event.kind === "bar" || event.kind === "start") {
    const allowed = new Set(["kind", "snapshotId", "asOfMs", "instrumentId", "interval", "market", "portfolio", "hostValidated"]);
    if (event.kind === "bar") allowed.add("bar");
    rejectUnknownFields(event, allowed, "event");
    validateActiveInstrumentEvent(event, asOfMs, event.kind);
    if (event.kind === "start" && event.portfolio === undefined) {
      fail("invalid_portfolio", `${event.kind} events require event.portfolio`);
    }
  } else {
    rejectUnknownFields(event, new Set(["kind", "snapshotId", "asOfMs", "market", "portfolio", "universe", "hostValidated"]), "event");
    if (!Array.isArray(event.universe) || event.universe.length === 0 || event.universe.length > 1_000) {
      fail("invalid_universe", "rebalance events must include 1 to 1000 universe rows");
    }
    const ids = new Set();
    event.universe.forEach((row, index) => {
      expectPlainObject(row, `event.universe[${index}]`);
      rejectUnknownFields(row, new Set(["instrumentId", "eligible"]), `event.universe[${index}]`);
      expectString(row.instrumentId, `event.universe[${index}].instrumentId`, { max: 64, pattern: INSTRUMENT_ID_PATTERN });
      if (ids.has(row.instrumentId)) fail("invalid_universe", "event.universe contains duplicate instrumentId values");
      ids.add(row.instrumentId);
      if (row.eligible !== undefined && typeof row.eligible !== "boolean") {
        fail("invalid_universe", `event.universe[${index}].eligible must be boolean when present`);
      }
      assertNoFutureTimestamp(row, asOfMs, `event.universe[${index}]`);
    });
  }
  assertNoFutureTimestamp(event, asOfMs);
  return value;
}

function validateNoAction(output) {
  rejectUnknownFields(output, new Set(["kind", "asOfMs", "reason"]), "output");
  if (output.kind !== "no_action") fail("invalid_output_kind", "strategy handlers may return no_action or action");
  if (output.reason !== undefined) expectString(output.reason, "output.reason", { max: 1_000 });
}

function validateProtection(protection) {
  const value = expectPlainObject(protection, "output.protection");
  rejectUnknownFields(value, new Set(["stopLossPrice", "takeProfitPrice"]), "output.protection");
  if (value.stopLossPrice === undefined && value.takeProfitPrice === undefined) {
    fail("invalid_output", "output.protection must request a stop-loss and/or take-profit price");
  }
  validateOptionalPositivePrice(value.stopLossPrice, "output.protection.stopLossPrice");
  validateOptionalPositivePrice(value.takeProfitPrice, "output.protection.takeProfitPrice");
}

function validateProtectionUpdate(protection) {
  const value = expectPlainObject(protection, "output.protection");
  rejectUnknownFields(value, new Set(["stopLossPrice", "takeProfitPrice"]), "output.protection");
  if (value.stopLossPrice === undefined && value.takeProfitPrice === undefined) {
    fail("invalid_output", "output.protection must update or clear a stop-loss and/or take-profit price");
  }
  for (const field of ["stopLossPrice", "takeProfitPrice"]) {
    if (value[field] !== undefined && value[field] !== null) expectPositiveFiniteNumber(value[field], `output.protection.${field}`);
  }
}

function validateExecution(execution) {
  const value = expectPlainObject(execution, "output.execution");
  rejectUnknownFields(value, new Set(["orderType", "limitPrice"]), "output.execution");
  const orderType = value.orderType ?? "market";
  if (!ORDER_TYPES.has(orderType)) fail("invalid_output", "output.execution.orderType must be market or limit");
  if (orderType === "market") {
    if (value.limitPrice !== undefined) fail("invalid_output", "market execution must not include limitPrice");
    return;
  }
  expectPositiveFiniteNumber(value.limitPrice, "output.execution.limitPrice");
}

function validateStrategyAction(output, event) {
  rejectUnknownFields(
    output,
    new Set(["kind", "asOfMs", "instrumentId", "action", "quantity", "reason", "protection", "execution", "orderId", "metadata"]),
    "output"
  );
  if (output.kind !== "action") fail("invalid_output_kind", "strategy action output.kind must be action");
  expectString(output.instrumentId, "output.instrumentId", { max: 64, pattern: INSTRUMENT_ID_PATTERN });
  if (output.instrumentId !== event.instrumentId) {
    fail("out_of_scope_output", "strategy action output.instrumentId must match event.instrumentId");
  }
  if (!STRATEGY_ACTIONS.has(output.action)) {
    fail("invalid_output", "output.action is unsupported");
  }
  const isExecutableAction = ["open_long", "open_short", "close_long", "close_short"].includes(output.action);
  if (isExecutableAction) {
    if (output.quantity !== undefined) {
      fail("invalid_output", "strategy actions must not include quantity; Desic calculates contracts from the configured position budget");
    }
    validateExecution(output.execution ?? { orderType: "market" });
  } else {
    if (output.quantity !== undefined) fail("invalid_output", `output.${output.action} must not include quantity`);
    if (output.execution !== undefined) fail("invalid_output", `output.${output.action} must not include execution`);
  }
  expectString(output.reason, "output.reason", { max: 1_000 });
  if (output.action.startsWith("close_") && event.portfolio !== undefined) {
    const side = output.action === "close_long" ? "long" : "short";
    const position = event.portfolio.positions.find(
      (item) => item.instrumentId === output.instrumentId && item.side === side
    );
    if (!position) {
      fail("invalid_output", `output.${output.action} requires a simulated ${side} position`);
    }
  }
  if (output.action !== "cancel_order" && output.orderId !== undefined) {
    fail("invalid_output", `output.${output.action} must not include orderId`);
  }
  if (output.action === "set_protection") {
    if (output.protection === undefined) fail("invalid_output", "output.set_protection requires protection");
    validateProtectionUpdate(output.protection);
    if (event.portfolio !== undefined && event.portfolio.positions.length === 0) {
      fail("invalid_output", "output.set_protection requires a simulated position");
    }
  } else if (output.action === "cancel_protection") {
    if (output.protection !== undefined) fail("invalid_output", "output.cancel_protection must not include protection");
    if (event.portfolio !== undefined && event.portfolio.positions.length === 0) {
      fail("invalid_output", "output.cancel_protection requires a simulated position");
    }
  } else if (output.action === "cancel_order") {
    if (output.protection !== undefined) fail("invalid_output", "output.cancel_order must not include protection");
    expectString(output.orderId, "output.orderId", { max: 128, pattern: REQUEST_ID_PATTERN });
    const openOrderIds = new Set((event.portfolio?.openOrders ?? []).map((order) => order.id));
    if (!openOrderIds.has(output.orderId)) {
      fail("invalid_output", "output.cancel_order must reference a current open order");
    }
  } else if (output.protection !== undefined) {
    if (!output.action.startsWith("open_")) {
      fail("invalid_output", "output.protection is only valid for open_long or open_short actions");
    }
    validateProtection(output.protection);
  }
  if (output.metadata !== undefined) ensureJsonValue(output.metadata, "output.metadata");
}

function validateSignal(output, event) {
  rejectUnknownFields(output, new Set(["kind", "asOfMs", "instrumentId", "direction", "reason", "confidence", "metadata"]), "output");
  expectString(output.instrumentId, "output.instrumentId", { max: 64, pattern: INSTRUMENT_ID_PATTERN });
  if (output.instrumentId !== event.instrumentId) {
    fail("out_of_scope_output", "bar signal output.instrumentId must match event.instrumentId");
  }
  if (!["long", "short", "exit"].includes(output.direction)) {
    fail("invalid_output", "signal.direction must be long, short, or exit");
  }
  expectString(output.reason, "output.reason", { max: 1_000 });
  if (output.confidence !== undefined && (typeof output.confidence !== "number" || output.confidence < 0 || output.confidence > 1)) {
    fail("invalid_output", "signal.confidence must be between 0 and 1");
  }
  if (output.metadata !== undefined) ensureJsonValue(output.metadata, "output.metadata");
}

function validatePaperIntent(output, event) {
  rejectUnknownFields(output, new Set(["kind", "asOfMs", "instrumentId", "action", "reason", "quantity", "metadata"]), "output");
  expectString(output.instrumentId, "output.instrumentId", { max: 64, pattern: INSTRUMENT_ID_PATTERN });
  if (output.instrumentId !== event.instrumentId) {
    fail("out_of_scope_output", "bar paper_intent output.instrumentId must match event.instrumentId");
  }
  if (!["open_long", "open_short", "close_long", "close_short"].includes(output.action)) {
    fail("invalid_output", "paper_intent.action is invalid");
  }
  expectString(output.reason, "output.reason", { max: 1_000 });
  if (output.quantity !== undefined) expectFiniteNumber(output.quantity, "output.quantity");
  if (output.quantity !== undefined && output.quantity <= 0) fail("invalid_output", "paper_intent.quantity must be positive");
  if (output.metadata !== undefined) ensureJsonValue(output.metadata, "output.metadata");
}

function validateRankedValues(rows, allowedIds, field) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > allowedIds.size) {
    fail("invalid_output", `output.${field} must contain 1 to ${allowedIds.size} rows`);
  }
  const ids = new Set();
  rows.forEach((row, index) => {
    expectPlainObject(row, `output.${field}[${index}]`);
    rejectUnknownFields(row, new Set(["instrumentId", "value", "diagnostics"]), `output.${field}[${index}]`);
    expectString(row.instrumentId, `output.${field}[${index}].instrumentId`, { max: 64, pattern: INSTRUMENT_ID_PATTERN });
    if (!allowedIds.has(row.instrumentId)) {
      fail("out_of_scope_output", `output.${field}[${index}].instrumentId is not an eligible universe instrument`);
    }
    if (ids.has(row.instrumentId)) fail("invalid_output", `output.${field} contains duplicate instrumentId values`);
    ids.add(row.instrumentId);
    expectFiniteNumber(row.value, `output.${field}[${index}].value`);
    if (row.diagnostics !== undefined) ensureJsonValue(row.diagnostics, `output.${field}[${index}].diagnostics`);
  });
}

function validatePortfolioWeights(rows, allowedIds) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > allowedIds.size) {
    fail("invalid_output", `output.weights must contain 1 to ${allowedIds.size} rows`);
  }
  const ids = new Set();
  rows.forEach((row, index) => {
    expectPlainObject(row, `output.weights[${index}]`);
    rejectUnknownFields(row, new Set(["instrumentId", "targetWeight"]), `output.weights[${index}]`);
    expectString(row.instrumentId, `output.weights[${index}].instrumentId`, { max: 64, pattern: INSTRUMENT_ID_PATTERN });
    if (!allowedIds.has(row.instrumentId)) {
      fail("out_of_scope_output", `output.weights[${index}].instrumentId is not an eligible universe instrument`);
    }
    if (ids.has(row.instrumentId)) fail("invalid_output", "output.weights contains duplicate instrumentId values");
    ids.add(row.instrumentId);
    const targetWeight = expectFiniteNumber(row.targetWeight, `output.weights[${index}].targetWeight`);
    if (Math.abs(targetWeight) > 1) fail("invalid_output", "individual targetWeight must be between -1 and 1");
  });
}

export function validateOutputForInvocation(output, invocation) {
  const request = validateInvokeRequest(invocation);
  const value = expectPlainObject(output, "output");
  const { event } = request;
  if (!Number.isSafeInteger(value.asOfMs) || value.asOfMs !== event.asOfMs) {
    fail("cutoff_mismatch", "output.asOfMs must exactly match event.asOfMs");
  }
  assertNoFutureTimestamp(value, event.asOfMs, "output");

  if (["start", "bar"].includes(event.kind)) {
    if (value.kind === "no_action") validateNoAction(value);
    else if (value.kind === "action") validateStrategyAction(value, event);
    // These output forms are accepted only for the original trusted desktop
    // sample and previously persisted research fixtures. New strategy packages
    // must emit high-level action outputs instead.
    else if (value.kind === "signal") validateSignal(value, event);
    else if (value.kind === "paper_intent") validatePaperIntent(value, event);
    else fail("invalid_output_kind", "strategy handlers may return no_action or action");
    if (event.kind !== "bar" && (value.kind === "signal" || value.kind === "paper_intent")) {
      fail("invalid_output_kind", "legacy signal and paper_intent outputs are valid only for on_bar");
    }
    return value;
  }

  const allowedIds = eligibleUniverseInstrumentIds(event);
  if (allowedIds.size === 0) fail("invalid_universe", "rebalance event has no eligible instruments");
  if (value.kind === "factor") {
    rejectUnknownFields(value, new Set(["kind", "asOfMs", "factorId", "values", "metadata"]), "output");
    expectString(value.factorId, "output.factorId", { max: 128, pattern: REQUEST_ID_PATTERN });
    validateRankedValues(value.values, allowedIds, "values");
  } else if (value.kind === "alpha") {
    rejectUnknownFields(value, new Set(["kind", "asOfMs", "modelId", "horizonMs", "scores", "metadata"]), "output");
    expectString(value.modelId, "output.modelId", { max: 128, pattern: REQUEST_ID_PATTERN });
    expectPositiveSafeInteger(value.horizonMs, "output.horizonMs");
    validateRankedValues(value.scores, allowedIds, "scores");
  } else if (value.kind === "portfolio_target") {
    rejectUnknownFields(value, new Set(["kind", "asOfMs", "weights", "metadata"]), "output");
    validatePortfolioWeights(value.weights, allowedIds);
  } else {
    fail("invalid_output_kind", "on_rebalance may return factor, alpha, or portfolio_target");
  }
  if (value.metadata !== undefined) ensureJsonValue(value.metadata, "output.metadata");
  return value;
}

function stripPythonStringsAndComments(source) {
  let output = "";
  let index = 0;
  let quote = null;
  let triple = false;
  let escaped = false;
  let comment = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    const nextNext = source[index + 2];
    if (comment) {
      if (current === "\n") {
        comment = false;
        output += "\n";
      } else {
        output += " ";
      }
      index += 1;
      continue;
    }
    if (quote) {
      if (current === "\n" && !triple) {
        quote = null;
        output += "\n";
        index += 1;
        continue;
      }
      if (current === "\n") output += "\n";
      else output += " ";
      if (!escaped && triple && current === quote && next === quote && nextNext === quote) {
        output += "  ";
        index += 3;
        quote = null;
        triple = false;
        continue;
      }
      if (!escaped && !triple && current === quote) quote = null;
      escaped = !escaped && current === "\\";
      if (current !== "\\") escaped = false;
      index += 1;
      continue;
    }
    if (current === "#") {
      comment = true;
      output += " ";
      index += 1;
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      triple = next === current && nextNext === current;
      output += triple ? "   " : " ";
      index += triple ? 3 : 1;
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}

function sourceLineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function validateImports(source, sanitized) {
  const imports = [];
  const importPattern = /(?:^|\n)\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([^\n#]+))/g;
  for (const match of sanitized.matchAll(importPattern)) {
    const candidates = match[1]
      ? [match[1]]
      : match[2].split(",").map((segment) => segment.trim().split(/\s+as\s+/i)[0].trim());
    for (const candidate of candidates) {
      const root = candidate.split(".")[0];
      const line = sourceLineNumber(sanitized, match.index ?? 0);
      if (candidate.startsWith(".") || FORBIDDEN_IMPORT_ROOTS.has(root) || !ALLOWED_IMPORT_ROOTS.has(root)) {
        fail("forbidden_import", `line ${line}: import of ${candidate} is not permitted`);
      }
      imports.push(root);
    }
  }
  return [...new Set(imports)].sort();
}

function validateHandlers(source, sanitized) {
  const handlers = [];
  const handlerPattern = /(?:^|\n)(async\s+)?def\s+(on_start|on_bar|on_fill|on_rebalance)\s*\(([^)]*)\)\s*:/g;
  for (const match of sanitized.matchAll(handlerPattern)) {
    const line = sourceLineNumber(sanitized, match.index ?? 0);
    if (match[1]) fail("invalid_handler", `line ${line}: async strategy handlers are not supported`);
    const argumentsList = match[3].split(",").map((argument) => argument.trim()).filter(Boolean);
    const firstArgument = argumentsList[0]?.split(/[=:]/)[0]?.trim();
    if (firstArgument !== "ctx") fail("invalid_handler", `line ${line}: ${match[2]} must accept ctx as its first argument`);
    if (argumentsList.some((argument) => argument.includes("="))) {
      fail("invalid_handler", `line ${line}: ${match[2]} must not define handler defaults`);
    }
    if (match[2] === "on_fill") {
      const secondArgument = argumentsList[1]?.split(/[=:]/)[0]?.trim();
      if (argumentsList.length !== 2 || secondArgument !== "fill") {
        fail("invalid_handler", `line ${line}: on_fill must accept exactly (ctx, fill)`);
      }
    } else if (argumentsList.length !== 1) {
      fail("invalid_handler", `line ${line}: ${match[2]} must accept exactly (ctx)`);
    }
    handlers.push(match[2]);
  }
  if (handlers.length === 0) {
    fail("missing_handler", "strategy source must define on_start(ctx), on_bar(ctx), and/or on_rebalance(ctx)");
  }
  if (new Set(handlers).size !== handlers.length) fail("duplicate_handler", "strategy source must not define a handler more than once");
  return handlers.sort();
}

export function validateStrategySource(source) {
  expectString(source, "strategy source", { max: MAX_STRATEGY_SOURCE_BYTES });
  if (Buffer.byteLength(source, "utf8") > MAX_STRATEGY_SOURCE_BYTES) {
    fail("source_too_large", `strategy source exceeds ${MAX_STRATEGY_SOURCE_BYTES} bytes`);
  }
  if (source.includes("\0")) fail("invalid_source", "strategy source must not contain NUL characters");
  const sanitized = stripPythonStringsAndComments(source);
  if (/\bclass\s+[A-Za-z_]/.test(sanitized)) fail("forbidden_syntax", "strategy source must not define classes");
  if (/\b(?:yield|await)\b/.test(sanitized)) fail("forbidden_syntax", "strategy source must not use yield or await");
  if (/\b__[A-Za-z0-9_]*\b/.test(sanitized)) fail("forbidden_syntax", "strategy source must not access dunder names");
  if (/\.\s*_[A-Za-z][A-Za-z0-9_]*/.test(sanitized)) fail("forbidden_syntax", "strategy source must not access private attributes");
  const forbiddenCallPattern = new RegExp(`\\b(?:${FORBIDDEN_CALLS.join("|")})\\s*\\(`);
  const forbiddenCall = sanitized.match(forbiddenCallPattern);
  if (forbiddenCall && typeof forbiddenCall.index === "number") {
    const api = forbiddenCall[0].replace(/\s*\($/, "").trim();
    const line = sourceLineNumber(sanitized, forbiddenCall.index);
    const guidance = api === "getattr"
      ? "Use documented fixed fields directly, for example position.averageEntryPrice."
      : "Use only the documented fixed strategy API.";
    fail("forbidden_api", `line ${line}: ${api} is not permitted in strategy source. ${guidance}`);
  }
  const imports = validateImports(source, sanitized);
  const handlers = validateHandlers(source, sanitized);
  return { handlers, imports, sourceSha256: createHash("sha256").update(source).digest("hex") };
}

export function parseProtocolLine(line, { maxBytes = MAX_JSONL_MESSAGE_BYTES } = {}) {
  if (typeof line !== "string") fail("invalid_jsonl", "JSONL line must be a string");
  if (Buffer.byteLength(line, "utf8") > maxBytes) fail("message_too_large", `JSONL line exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(line);
  } catch {
    fail("invalid_jsonl", "JSONL line is not valid JSON");
  }
}

export function serializeProtocolLine(message, { maxBytes = MAX_JSONL_MESSAGE_BYTES } = {}) {
  ensureJsonValue(message, "message");
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, "utf8") > maxBytes) fail("message_too_large", `JSONL line exceeds ${maxBytes} bytes`);
  return `${line}\n`;
}

export async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function verifyPinnedPythonRuntime(pythonPath, expectedSha256) {
  expectString(pythonPath, "pythonPath", { max: 8_192 });
  expectString(expectedSha256, "expectedSha256", { min: 64, max: 64, pattern: /^[a-fA-F0-9]{64}$/ });
  const actual = await sha256File(pythonPath);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    fail("runtime_checksum_mismatch", "bundled Python runtime checksum does not match its approved manifest");
  }
  return actual;
}

export function protocolErrorPayload(error) {
  if (error instanceof PythonStrategyProtocolError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: "internal_error", message: "unexpected Python strategy protocol error" };
}
