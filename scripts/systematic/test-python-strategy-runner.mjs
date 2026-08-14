import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PYTHON_STRATEGY_PROTOCOL,
  PythonStrategyProtocolError,
  sha256File,
  validateInvokeRequest,
  validateOutputForInvocation,
  validateStrategyParameters,
  validateStrategySource
} from "./python-protocol.mjs";
import { ManagedPythonStrategyRunner } from "./python-strategy-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = path.join(root, "scripts", "fixtures", "systematic-python");
const runtimePath = path.join(root, "scripts", "systematic", "python-strategy-runtime.py");
const cutoffMs = 1_700_000_120_000;

async function fixture(name) {
  return readFile(path.join(fixtures, name), "utf8");
}

async function builtinTemplate(name) {
  return readFile(path.join(root, "src-tauri", "resources", "systematic-python", "templates", name), "utf8");
}

function bar(openTimeMs, closeTimeMs, open, high, low, close, volume) {
  return { openTimeMs, closeTimeMs, open, high, low, close, volume, confirmed: true };
}

const btcBars = [
  bar(1_700_000_000_000, 1_700_000_060_000, 100, 103, 99, 101, 10),
  bar(1_700_000_060_000, cutoffMs, 101, 105, 100, 104, 14)
];
const ethBars = [
  bar(1_700_000_000_000, 1_700_000_060_000, 50, 51, 49, 50, 20),
  bar(1_700_000_060_000, cutoffMs, 50, 52, 49, 51, 18)
];

function barInvocation() {
  const bars = btcBars.map((item) => ({ ...item }));
  return {
    protocol: PYTHON_STRATEGY_PROTOCOL,
    type: "invoke",
    requestId: "bar-fixture-1",
    event: {
      kind: "bar",
      snapshotId: "market-fixture-1",
      asOfMs: cutoffMs,
      instrumentId: "BTC-USDT-SWAP",
      interval: "1m",
      bar: bars[1],
      market: {
        series: [{ instrumentId: "BTC-USDT-SWAP", interval: "1m", bars }]
      }
    }
  };
}

function withPartialHigherTimeframe(request) {
  const previous = {
    openTimeMs: cutoffMs - 420_000,
    closeTimeMs: cutoffMs - 120_000,
    open: 98,
    high: 103,
    low: 97,
    close: 101,
    volume: 40,
    confirmed: true
  };
  const partial = {
    openTimeMs: cutoffMs - 120_000,
    closeTimeMs: cutoffMs + 180_000,
    open: 101,
    high: 105,
    low: 100,
    close: 104,
    volume: 18,
    confirmed: false
  };
  request.event.market.series.push({
    instrumentId: request.event.instrumentId,
    interval: "5m",
    bars: [previous, partial]
  });
  return request;
}

function simulatedPortfolio(overrides = {}) {
  return {
    cashUsdt: 10_000,
    equityUsdt: 10_000,
    availableMarginUsdt: 9_500,
    positions: [],
    openOrders: [],
    recentFills: [],
    trades: [],
    ...overrides
  };
}

function strategyEvent(kind, { portfolio = simulatedPortfolio(), requestId } = {}) {
  const bars = btcBars.map((item) => ({ ...item }));
  const event = {
    kind,
    snapshotId: `strategy-${kind}-fixture-1`,
    asOfMs: cutoffMs,
    instrumentId: "BTC-USDT-SWAP",
    interval: "1m",
    market: {
      series: [{ instrumentId: "BTC-USDT-SWAP", interval: "1m", bars }]
    },
    portfolio
  };
  if (kind === "bar") event.bar = bars[1];
  return {
    protocol: PYTHON_STRATEGY_PROTOCOL,
    type: "invoke",
    requestId: requestId ?? `${kind}-fixture-1`,
    event
  };
}

function openLongAction(overrides = {}) {
  return {
    kind: "action",
    asOfMs: cutoffMs,
    instrumentId: "BTC-USDT-SWAP",
    action: "open_long",
    reason: "closed-bar momentum confirmation",
    protection: { stopLossPrice: 99, takeProfitPrice: 110 },
    ...overrides
  };
}

function rebalanceInvocation() {
  const btc = btcBars.map((item) => ({ ...item }));
  const eth = ethBars.map((item) => ({ ...item }));
  return {
    protocol: PYTHON_STRATEGY_PROTOCOL,
    type: "invoke",
    requestId: "rebalance-fixture-1",
    event: {
      kind: "rebalance",
      snapshotId: "market-fixture-1",
      asOfMs: cutoffMs,
      universe: [
        { instrumentId: "BTC-USDT-SWAP", eligible: true },
        { instrumentId: "ETH-USDT-SWAP", eligible: true },
        { instrumentId: "LONGTAIL-USDT-SWAP", eligible: false }
      ],
      market: {
        series: [
          { instrumentId: "BTC-USDT-SWAP", interval: "1m", bars: btc },
          { instrumentId: "ETH-USDT-SWAP", interval: "1m", bars: eth }
        ]
      }
    }
  };
}

function expectProtocolFailure(label, operation, code) {
  assert.throws(operation, (error) => {
    assert(error instanceof PythonStrategyProtocolError, `${label} must fail with PythonStrategyProtocolError`);
    if (code) assert.equal(error.code, code, `${label} code`);
    return true;
  });
}

async function runRawRuntime(pythonPath, messages) {
  const environment = {
    PYTHONHASHSEED: "0",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONSAFEPATH: "1",
    PYTHONUTF8: "1"
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
  }
  const child = spawn(pythonPath, ["-I", "-u", runtimePath], {
    cwd: os.tmpdir(),
    env: environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  const [code, signal] = await once(child, "close");
  assert.equal(code, 0, `raw runtime must exit cleanly (${signal ?? "no signal"}): ${stderr}`);
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const validBarSource = await fixture("valid-momentum-bar.py");
const validFactorSource = await fixture("valid-momentum-factor.py");
const validStatefulSource = await fixture("valid-stateful-strategy.py");
const validThirtyMinuteMacdProtectionSource = await fixture("valid-30m-macd-protection.py");
assert.deepEqual(validateStrategySource(validBarSource).handlers, ["on_bar"]);
assert.deepEqual(validateStrategySource(validFactorSource).handlers, ["on_rebalance"]);
assert.deepEqual(validateStrategySource(validStatefulSource).handlers, ["on_bar", "on_start"]);
assert.deepEqual(validateStrategySource(validThirtyMinuteMacdProtectionSource).handlers, ["on_bar"]);
for (const name of ["blank.py", "ema-trend.py", "macd-volume-atr.py", "bollinger-reversion.py"]) {
  const source = await builtinTemplate(name);
  assert.deepEqual(validateStrategySource(source).handlers, ["on_bar"], `built-in template ${name}`);
}
const blankTemplateSource = await builtinTemplate("blank.py");
assert.match(blankTemplateSource, /ctx\.no_action/);
assert.doesNotMatch(blankTemplateSource, /ctx\.(open|close)_/);
assert.deepEqual(
  validateStrategySource("def on_bar(ctx):\n    return ctx.no_action()\n\ndef on_fill(ctx, fill):\n    return ctx.no_action()\n").handlers,
  ["on_bar", "on_fill"],
  "legacy fill hooks remain loadable but are not dispatched by current adapters"
);
expectProtocolFailure(
  "handler defaults are not part of the SDK",
  () => validateStrategySource("def on_bar(ctx=None):\n    return ctx.no_action()\n"),
  "invalid_handler"
);
expectProtocolFailure(
  "private context attributes are unavailable",
  () => validateStrategySource("def on_bar(ctx):\n    ctx.indicators._cache._ema.clear()\n    return ctx.no_action()\n"),
  "forbidden_syntax"
);

for (const [name, code] of [
  ["invalid-network-import.py", "forbidden_import"],
  ["invalid-filesystem-import.py", "forbidden_import"],
  ["invalid-subprocess-import.py", "forbidden_import"],
  ["invalid-open-call.py", "forbidden_api"]
]) {
  const source = await fixture(name);
  expectProtocolFailure(name, () => validateStrategySource(source), code);
}
assert.throws(
  () => validateStrategySource("def on_bar(ctx):\n    return getattr(ctx.portfolio, 'equity_usdt', 0)\n"),
  (error) => {
    assert(error instanceof PythonStrategyProtocolError, "dynamic attribute access must use the protocol error type");
    assert.equal(error.code, "forbidden_api");
    assert.match(error.message, /^line 2: getattr is not permitted in strategy source\. Use documented fixed fields directly, for example position\.averageEntryPrice\.$/);
    return true;
  }
);

const validBarRequest = barInvocation();
validateInvokeRequest(validBarRequest);
const hostValidatedRequest = barInvocation();
hostValidatedRequest.event.hostValidated = true;
validateInvokeRequest(hostValidatedRequest);
assert.deepEqual(validateStrategyParameters({ fastPeriod: 10, label: "closed bar" }), {
  fastPeriod: 10,
  label: "closed bar"
});
expectProtocolFailure(
  "strategy parameters must remain an object",
  () => validateStrategyParameters([10, 20]),
  "invalid_shape"
);
const partialHigherTimeframeRequest = withPartialHigherTimeframe(strategyEvent("bar"));
validateInvokeRequest(partialHigherTimeframeRequest);
const nonFinalPartialHigherTimeframeRequest = withPartialHigherTimeframe(strategyEvent("bar"));
nonFinalPartialHigherTimeframeRequest.event.market.series[1].bars.unshift({
  openTimeMs: cutoffMs - 720_000,
  closeTimeMs: cutoffMs - 420_000,
  open: 96,
  high: 99,
  low: 95,
  close: 98,
  volume: 30,
  confirmed: false
});
expectProtocolFailure(
  "only the latest higher-timeframe bar may be partial",
  () => validateInvokeRequest(nonFinalPartialHigherTimeframeRequest),
  "invalid_bar"
);
assert.deepEqual(
  validateOutputForInvocation(
    {
      kind: "signal",
      asOfMs: cutoffMs,
      instrumentId: "BTC-USDT-SWAP",
      direction: "long",
      reason: "closed-bar confirmation",
      confidence: 0.65
    },
    validBarRequest
  ).kind,
  "signal"
);

const futureRequest = barInvocation();
futureRequest.event.market.series[0].bars[1] = { ...futureRequest.event.market.series[0].bars[1], closeTimeMs: cutoffMs + 60_000 };
expectProtocolFailure("future bar data", () => validateInvokeRequest(futureRequest), "future_data");
const injectedMarketField = barInvocation();
injectedMarketField.event.market.series[0].bars[1] = {
  ...injectedMarketField.event.market.series[0].bars[1],
  nextClose: 999
};
expectProtocolFailure("unrecognized market data is not exposed", () => validateInvokeRequest(injectedMarketField), "unknown_field");
expectProtocolFailure(
  "cutoff mismatch",
  () => validateOutputForInvocation({ kind: "no_action", asOfMs: cutoffMs + 1 }, validBarRequest),
  "cutoff_mismatch"
);
expectProtocolFailure(
  "bar output scope",
  () => validateOutputForInvocation({ kind: "signal", asOfMs: cutoffMs, instrumentId: "ETH-USDT-SWAP", direction: "long", reason: "wrong instrument" }, validBarRequest),
  "out_of_scope_output"
);
expectProtocolFailure(
  "output future timestamp",
  () => validateOutputForInvocation(
    {
      kind: "signal",
      asOfMs: cutoffMs,
      instrumentId: "BTC-USDT-SWAP",
      direction: "long",
      reason: "invalid metadata timestamp",
      metadata: { observedAtMs: cutoffMs + 1 }
    },
    validBarRequest
  ),
  "future_data"
);
expectProtocolFailure(
  "unknown output field",
  () => validateOutputForInvocation(
    {
      kind: "no_action",
      asOfMs: cutoffMs,
      futureCurve: [1, 2]
    },
    validBarRequest
  ),
  "unknown_field"
);

const validStartRequest = strategyEvent("start");
const validStrategyBarRequest = strategyEvent("bar");
const simulatedFill = {
  id: "fill-1",
  orderId: "order-1",
  instrumentId: "BTC-USDT-SWAP",
  action: "open_long",
  quantity: 2,
  price: 104,
  filledAtMs: cutoffMs,
  feeUsdt: 0.12
};
const simulatedLongPosition = {
  instrumentId: "BTC-USDT-SWAP",
  side: "long",
  quantity: 1.5,
  averageEntryPrice: 100,
  markPrice: 104,
  openedAtMs: btcBars[0].closeTimeMs,
  updatedAtMs: cutoffMs
};
const simulatedClosedTrade = {
  id: "trade-1",
  instrumentId: "BTC-USDT-SWAP",
  side: "long",
  quantity: 2,
  entryPrice: 100,
  exitPrice: 104,
  openedAtMs: btcBars[0].closeTimeMs,
  closedAtMs: cutoffMs,
  realizedPnlUsdt: 7.88,
  feesUsdt: 0.12
};
validateInvokeRequest(validStartRequest);
validateInvokeRequest(validStrategyBarRequest);
const validPositionedBarRequest = strategyEvent("bar", {
  portfolio: simulatedPortfolio({ positions: [simulatedLongPosition] })
});
validateInvokeRequest(validPositionedBarRequest);
assert.equal(
  validateOutputForInvocation(
    {
      kind: "action",
      asOfMs: cutoffMs,
      instrumentId: "BTC-USDT-SWAP",
      action: "set_protection",
      reason: "replace the take-profit while retaining the stop",
      protection: { takeProfitPrice: 110 }
    },
    validPositionedBarRequest
  ).action,
  "set_protection"
);
assert.equal(
  validateOutputForInvocation(
    {
      kind: "action",
      asOfMs: cutoffMs,
      instrumentId: "BTC-USDT-SWAP",
      action: "cancel_protection",
      reason: "manage the virtual position manually"
    },
    validPositionedBarRequest
  ).action,
  "cancel_protection"
);
validateInvokeRequest(strategyEvent("bar", {
  portfolio: simulatedPortfolio({ ledgerMode: "append" })
}));
expectProtocolFailure(
  "invalid portfolio ledger mode",
  () => validateInvokeRequest(strategyEvent("bar", { portfolio: simulatedPortfolio({ ledgerMode: "replace-all" }) })),
  "invalid_portfolio"
);
assert.equal(validateOutputForInvocation(openLongAction(), validStrategyBarRequest).kind, "action");
assert.deepEqual(
  validateOutputForInvocation(
    openLongAction({ execution: { orderType: "limit", limitPrice: 101 } }),
    validStrategyBarRequest
  ).execution,
  { orderType: "limit", limitPrice: 101 }
);
const pendingOrder = {
  id: "paper-order-1",
  instrumentId: "BTC-USDT-SWAP",
  action: "open_long",
  quantity: 2,
  filledQuantity: 1,
  status: "partially_filled",
  createdAtMs: cutoffMs,
  price: 101
};
const pendingOrderRequest = strategyEvent("bar", {
  portfolio: simulatedPortfolio({ openOrders: [pendingOrder] })
});
validateInvokeRequest(pendingOrderRequest);
assert.equal(
  validateOutputForInvocation(
    {
      kind: "action",
      asOfMs: cutoffMs,
      instrumentId: "BTC-USDT-SWAP",
      action: "cancel_order",
      orderId: pendingOrder.id,
      reason: "signal is no longer valid"
    },
    pendingOrderRequest
  ).action,
  "cancel_order"
);
expectProtocolFailure(
  "cancel order must be visible in the current portfolio",
  () => validateOutputForInvocation(
    {
      kind: "action",
      asOfMs: cutoffMs,
      instrumentId: "BTC-USDT-SWAP",
      action: "cancel_order",
      orderId: "manual-order",
      reason: "must not target another order"
    },
    pendingOrderRequest
  ),
  "invalid_output"
);
expectProtocolFailure(
  "market execution cannot include a limit price",
  () => validateOutputForInvocation(
    openLongAction({ execution: { orderType: "market", limitPrice: 101 } }),
    validStrategyBarRequest
  ),
  "invalid_output"
);
assert.equal(
  validateOutputForInvocation({ kind: "no_action", asOfMs: cutoffMs, reason: "no new decision" }, validStartRequest).kind,
  "no_action"
);

const startWithoutPortfolio = strategyEvent("start");
delete startWithoutPortfolio.event.portfolio;
expectProtocolFailure("start portfolio required", () => validateInvokeRequest(startWithoutPortfolio), "invalid_portfolio");

const futurePortfolioRequest = strategyEvent("bar", {
  portfolio: simulatedPortfolio({
    recentFills: [{ ...simulatedFill, filledAtMs: cutoffMs + 1 }]
  })
});
expectProtocolFailure("future simulated fill", () => validateInvokeRequest(futurePortfolioRequest), "future_data");

expectProtocolFailure(
  "close action requires the simulated side",
  () => validateOutputForInvocation(openLongAction({ action: "close_long" }), validStrategyBarRequest),
  "invalid_output"
);
expectProtocolFailure(
  "protection on close action",
  () => validateOutputForInvocation(openLongAction({ action: "close_long", quantity: 1 }), validPositionedBarRequest),
  "invalid_output"
);
expectProtocolFailure(
  "close action cannot exceed the simulated position",
  () => validateOutputForInvocation(openLongAction({ action: "close_long", quantity: 2, protection: undefined }), validPositionedBarRequest),
  "invalid_output"
);
expectProtocolFailure(
  "action must not include strategy-owned quantity",
  () => validateOutputForInvocation(openLongAction({ quantity: 0 }), validStrategyBarRequest),
  "invalid_output"
);
expectProtocolFailure(
  "action cannot inject exchange order fields",
  () => validateOutputForInvocation(openLongAction({ accountId: "external-account" }), validStrategyBarRequest),
  "unknown_field"
);
expectProtocolFailure(
  "action cannot target a different instrument",
  () => validateOutputForInvocation(openLongAction({ instrumentId: "ETH-USDT-SWAP" }), validStrategyBarRequest),
  "out_of_scope_output"
);

const validRebalanceRequest = rebalanceInvocation();
validateInvokeRequest(validRebalanceRequest);
assert.equal(
  validateOutputForInvocation(
    {
      kind: "factor",
      asOfMs: cutoffMs,
      factorId: "momentum-v1",
      values: [
        { instrumentId: "BTC-USDT-SWAP", value: 0.03 },
        { instrumentId: "ETH-USDT-SWAP", value: 0.02 }
      ]
    },
    validRebalanceRequest
  ).kind,
  "factor"
);
expectProtocolFailure(
  "ineligible universe output",
  () => validateOutputForInvocation(
    {
      kind: "factor",
      asOfMs: cutoffMs,
      factorId: "momentum-v1",
      values: [{ instrumentId: "LONGTAIL-USDT-SWAP", value: 1 }]
    },
    validRebalanceRequest
  ),
  "out_of_scope_output"
);

const testPython = process.env.DESIC_SYSTEMATIC_TEST_PYTHON;
if (testPython) {
  const staticContractOutput = await runRawRuntime(path.resolve(testPython), [
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "load",
      requestId: "raw-load-invalid-positional-action",
      source: [
        "def on_bar(ctx):",
        "    return ctx.open_long('entry reason', 60000, 'extra positional argument')"
      ].join("\n")
    },
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "load",
      requestId: "raw-load-duplicate-reason-action",
      source: [
        "def on_bar(ctx):",
        "    return ctx.open_long('entry reason', reason='duplicate reason')"
      ].join("\n")
    },
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "load",
      requestId: "raw-load-unknown-context-action",
      source: [
        "def on_bar(ctx):",
        "    return ctx.open_long_limit(1, 'unsupported alias')"
      ].join("\n")
    },
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "shutdown",
      requestId: "raw-shutdown-static-contract"
    }
  ]);
  assert.equal(staticContractOutput[0].type, "ready");
  assert.equal(staticContractOutput[1].code, "invalid_strategy_api");
  assert.match(staticContractOutput[1].message, /^line 2: ctx\.open_long accepts at most 1 positional arguments; pass optional arguments by name$/);
  assert.equal(staticContractOutput[2].code, "invalid_strategy_api");
  assert.match(staticContractOutput[2].message, /^line 2: ctx\.open_long receives reason as its first positional argument; do not also pass reason=\.\.\. \. Desic chooses contract size from the configured position budget\. For a limit order use ctx\.open_long\(reason, execution=ctx\.limit_order\(price\)\)$/);
  assert.equal(staticContractOutput[3].code, "invalid_strategy_api");
  assert.match(staticContractOutput[3].message, /^line 2: ctx\.open_long_limit is not part of the documented strategy API$/);
  assert.equal(staticContractOutput[4].type, "shutdown");

  const batchOutput = await runRawRuntime(path.resolve(testPython), [
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "load",
      requestId: "raw-load-batch",
      source: blankTemplateSource
    },
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "invoke_batch",
      requestId: "raw-batch-no-action",
      events: [strategyEvent("bar").event, strategyEvent("bar").event]
    },
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "shutdown",
      requestId: "raw-shutdown-batch"
    }
  ]);
  assert.equal(batchOutput[0].type, "ready");
  assert.equal(batchOutput[1].type, "loaded");
  assert.deepEqual(batchOutput[1].marketIntervals, ["1m"]);
  assert.equal(batchOutput[2].type, "result");
  assert.equal(batchOutput[2].outputs.length, 2);
  assert.deepEqual(batchOutput[2].outputs.map((output) => output.kind), ["no_action", "no_action"]);
  assert.equal(batchOutput[3].type, "shutdown");

  const indicatorOutput = await runRawRuntime(testPython, [
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "load",
      requestId: "raw-indicator-load",
      source: `def on_bar(ctx):
    ema = ctx.indicators.ema(ctx.instrument_id, "1m", 2)
    previous_ema = ctx.indicators.ema(ctx.instrument_id, "1m", 2, offset=1)
    atr = ctx.indicators.atr(ctx.instrument_id, "1m", 1)
    return ctx.open_long("indicator values", metadata={"ema": ema, "previousEma": previous_ema or -1, "atr": atr})
`,
      params: {}
    },
    { ...barInvocation(), requestId: "raw-indicator-invoke" },
    {
      ...strategyEvent("bar", { requestId: "raw-indicator-incremental" }),
      event: {
        ...strategyEvent("bar", { requestId: "raw-indicator-incremental" }).event,
        asOfMs: cutoffMs + 60_000,
        bar: bar(cutoffMs, cutoffMs + 60_000, 104, 106, 102, 103, 16),
        market: {
          series: [{
            instrumentId: "BTC-USDT-SWAP",
            interval: "1m",
            bars: [bar(cutoffMs, cutoffMs + 60_000, 104, 106, 102, 103, 16)]
          }]
        }
      }
    },
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "shutdown",
      requestId: "raw-indicator-shutdown"
    }
  ]);
  assert.deepEqual(indicatorOutput[1].marketIntervals, ["1m"]);
  assert.equal(indicatorOutput[2].output.kind, "action");
  assert.equal(indicatorOutput[2].output.metadata.ema, 102.5);
  assert.equal(indicatorOutput[2].output.metadata.previousEma, -1);
  assert.equal(indicatorOutput[2].output.metadata.atr, 5);
  assert.equal(indicatorOutput[3].output.metadata.ema, 102.83333333333333);
  assert.equal(indicatorOutput[3].output.metadata.previousEma, 102.5);
  assert.equal(indicatorOutput[3].output.metadata.atr, 4);

  const chunkedBars = Array.from({ length: 600 }, (_, index) => bar(
    cutoffMs + index * 60_000,
    cutoffMs + (index + 1) * 60_000,
    100 + index,
    101 + index,
    99 + index,
    100 + index,
    1
  ));
  const chunkedTailOutput = await runRawRuntime(testPython, [
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "load",
      requestId: "raw-chunked-tail-load",
      source: `def on_bar(ctx):
    recent = ctx.market.bars(ctx.instrument_id, "1m", lookback=3)
    return ctx.open_long("chunked tail", metadata={"count": len(recent), "first": recent[0].close, "last": recent[-1].close})
`,
      params: {}
    },
    {
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "invoke",
      requestId: "raw-chunked-tail-invoke",
      event: {
        kind: "bar",
        snapshotId: "chunked-tail-fixture",
        asOfMs: cutoffMs + 600 * 60_000,
        instrumentId: "BTC-USDT-SWAP",
        interval: "1m",
        bar: chunkedBars.at(-1),
        market: {
          series: [{ instrumentId: "BTC-USDT-SWAP", interval: "1m", bars: chunkedBars }]
        }
      }
    },
    { protocol: PYTHON_STRATEGY_PROTOCOL, type: "shutdown", requestId: "raw-chunked-tail-shutdown" }
  ]);
  assert.deepEqual(chunkedTailOutput[2].output.metadata, { count: 3, first: 697, last: 699 });

  const runner = new ManagedPythonStrategyRunner({
    pythonPath: path.resolve(testPython),
    expectedRuntimeSha256: await sha256File(path.resolve(testPython)),
    requestTimeoutMs: 5_000
  });
  try {
    const loaded = await runner.load(validBarSource);
    assert.deepEqual(loaded.handlers, ["on_bar"]);
    const output = await runner.invoke(barInvocation());
    assert.equal(output.kind, "signal");
    assert.equal(output.asOfMs, cutoffMs);
    assert.equal(output.instrumentId, "BTC-USDT-SWAP");
    const incrementalCutoffMs = cutoffMs + 60_000;
    const incrementalBar = bar(cutoffMs, incrementalCutoffMs, 104, 107, 103, 106, 19);
    const incrementalOutput = await runner.invoke({
      protocol: PYTHON_STRATEGY_PROTOCOL,
      type: "invoke",
      requestId: "bar-fixture-incremental",
      event: {
        kind: "bar",
        snapshotId: "market-fixture-incremental",
        asOfMs: incrementalCutoffMs,
        instrumentId: "BTC-USDT-SWAP",
        interval: "1m",
        bar: incrementalBar,
        market: {
          series: [{ instrumentId: "BTC-USDT-SWAP", interval: "1m", bars: [incrementalBar] }]
        }
      }
    });
    assert.equal(incrementalOutput.kind, "signal");
    assert.equal(incrementalOutput.asOfMs, incrementalCutoffMs);

    const parameterAndHigherTimeframeSource = [
      "def on_bar(ctx):",
      "    bars = ctx.market.bars(ctx.instrument_id, '5m', lookback=2)",
      "    if ctx.params['fastPeriod'] != 10:",
      "        return ctx.no_action('unexpected saved parameter')",
      "    if bars[-1].confirmed:",
      "        return ctx.no_action('higher timeframe unexpectedly confirmed')",
      "    return ctx.set_protection('observe the active higher timeframe bar', take_profit_price=110)"
    ].join("\n");
    await runner.load(parameterAndHigherTimeframeSource, { fastPeriod: 10 });
    const parameterAndHigherTimeframeOutput = await runner.invoke(withPartialHigherTimeframe(strategyEvent("bar", {
      requestId: "parameter-and-partial-higher-timeframe",
      portfolio: simulatedPortfolio({ positions: [simulatedLongPosition] })
    })));
    assert.deepEqual(parameterAndHigherTimeframeOutput, {
      kind: "action",
      asOfMs: cutoffMs,
      instrumentId: "BTC-USDT-SWAP",
      action: "set_protection",
      reason: "observe the active higher timeframe bar",
      protection: { takeProfitPrice: 110 }
    });

    const limitExecutionSource = [
      "def on_bar(ctx):",
      "    return ctx.open_long('place a pullback bid', execution=ctx.limit_order(101))"
    ].join("\n");
    await runner.load(limitExecutionSource);
    const limitExecutionOutput = await runner.invoke(strategyEvent("bar", {
      requestId: "limit-execution-output"
    }));
    assert.deepEqual(limitExecutionOutput.execution, { orderType: "limit", limitPrice: 101 });

    const unsupportedPositionFieldSource = [
      "def on_bar(ctx):",
      "    position = ctx.portfolio.position(ctx.instrument_id, 'long')",
      "    return ctx.no_action(str(position.contracts))"
    ].join("\n");
    await assert.rejects(
      () => runner.load(unsupportedPositionFieldSource),
      (error) => error?.code === "invalid_strategy_api" && /position\.quantity/.test(error.message)
    );

    const unsupportedLimitShortcutSource = [
      "def on_bar(ctx):",
      "    return ctx.open_long_limit(1, 101, 'unsupported shortcut')"
    ].join("\n");
    await assert.rejects(
      () => runner.load(unsupportedLimitShortcutSource),
      (error) => error?.code === "invalid_strategy_api" && /open_long_limit/.test(error.message)
    );

    const cancelOrderSource = [
      "def on_bar(ctx):",
      "    if ctx.portfolio.open_orders:",
      "        order = ctx.portfolio.open_orders[0]",
      "        return ctx.cancel_order(order.id, 'cancel remaining quantity')",
      "    return ctx.no_action('no pending order')"
    ].join("\n");
    await runner.load(cancelOrderSource);
    const cancelOrderOutput = await runner.invoke(strategyEvent("bar", {
      requestId: "cancel-order-output",
      portfolio: simulatedPortfolio({ openOrders: [pendingOrder] })
    }));
    assert.equal(cancelOrderOutput.action, "cancel_order");
    assert.equal(cancelOrderOutput.orderId, pendingOrder.id);

    // Keep an early market view alive while enough incremental events cross
    // multiple cache chunks. A later event must not leak into that old view.
    const snapshotIsolationSource = [
      "saved_market = []",
      "saved_cutoff = []",
      "",
      "def on_bar(ctx):",
      "    if not saved_market:",
      "        saved_market.append(ctx.market)",
      "        saved_cutoff.append(ctx.as_of_ms)",
      "    else:",
      "        prior = saved_market[0].bars(ctx.instrument_id, ctx.interval)",
      "        if prior[-1].closeTimeMs != saved_cutoff[0]:",
      "            return ctx.open_long('future bar leaked into a retained market snapshot')",
      "    return ctx.no_action('market snapshot remains point in time')"
    ].join("\n");
    await runner.load(snapshotIsolationSource);
    const initialSnapshotOutput = await runner.invoke(barInvocation());
    assert.equal(initialSnapshotOutput.kind, "no_action");
    let previousIncrementalBar = btcBars[1];
    for (let index = 0; index < 640; index += 1) {
      const nextClose = previousIncrementalBar.closeTimeMs + 60_000;
      const nextBar = bar(
        previousIncrementalBar.closeTimeMs,
        nextClose,
        previousIncrementalBar.close,
        previousIncrementalBar.close + 2,
        previousIncrementalBar.close - 1,
        previousIncrementalBar.close + 0.5,
        previousIncrementalBar.volume + 1
      );
      const output = await runner.invoke({
        protocol: PYTHON_STRATEGY_PROTOCOL,
        type: "invoke",
        requestId: `snapshot-isolation-${index}`,
        event: {
          kind: "bar",
          snapshotId: "market-fixture-snapshot-isolation",
          asOfMs: nextClose,
          instrumentId: "BTC-USDT-SWAP",
          interval: "1m",
          bar: nextBar,
          market: {
            series: [{ instrumentId: "BTC-USDT-SWAP", interval: "1m", bars: [nextBar] }]
          }
        }
      });
      assert.equal(output.kind, "no_action");
      previousIncrementalBar = nextBar;
    }

    const ledgerSnapshotSource = [
      "saved_portfolios = []",
      "def on_bar(ctx):",
      "    if not saved_portfolios:",
      "        saved_portfolios.append(ctx.portfolio)",
      "    fills = len(ctx.portfolio.recent_fills)",
      "    trades = len(ctx.portfolio.trades)",
      "    retained_fills = len(saved_portfolios[0].recent_fills)",
      "    return ctx.no_action(str(fills) + ':' + str(trades) + ':' + str(retained_fills))"
    ].join("\n");
    await runner.load(ledgerSnapshotSource);
    const initialLedgerOutput = await runner.invoke(strategyEvent("bar", {
      requestId: "ledger-replace",
      portfolio: simulatedPortfolio({
        recentFills: [simulatedFill],
        trades: [simulatedClosedTrade],
        ledgerMode: "replace"
      })
    }));
    assert.equal(initialLedgerOutput.reason, "1:1:1");
    const appendedFill = { ...simulatedFill, id: "fill-2", orderId: "order-2", quantity: 1, price: 105 };
    const appendedTrade = {
      ...simulatedClosedTrade,
      id: "trade-2",
      quantity: 1,
      entryPrice: 104,
      exitPrice: 105,
      realizedPnlUsdt: 0.88
    };
    const appendedLedgerOutput = await runner.invoke(strategyEvent("bar", {
      requestId: "ledger-append",
      portfolio: simulatedPortfolio({
        recentFills: [appendedFill],
        trades: [appendedTrade],
        ledgerMode: "append"
      })
    }));
    assert.equal(appendedLedgerOutput.reason, "2:2:1");
    await assert.rejects(
      () => runner.invoke(strategyEvent("bar", {
        requestId: "ledger-duplicate-append",
        portfolio: simulatedPortfolio({
          recentFills: [appendedFill],
          trades: [],
          ledgerMode: "append"
        })
      })),
      (error) => error?.code === "invalid_portfolio"
    );

    const factorLoaded = await runner.load(validFactorSource);
    assert.deepEqual(factorLoaded.handlers, ["on_rebalance"]);
    const factorOutput = await runner.invoke(rebalanceInvocation());
    assert.equal(factorOutput.kind, "factor");
    assert.equal(factorOutput.asOfMs, cutoffMs);
    assert.equal(factorOutput.values.length, 2);

    const statefulLoaded = await runner.load(validStatefulSource);
    assert.deepEqual(statefulLoaded.handlers, ["on_bar", "on_start"]);
    await assert.rejects(
      () => runner.invoke(strategyEvent("bar", { requestId: "stateful-before-start" })),
      (error) => error instanceof PythonStrategyProtocolError && error.code === "invalid_lifecycle"
    );
    const startOutput = await runner.invoke(strategyEvent("start", { requestId: "stateful-start" }));
    assert.equal(startOutput.kind, "no_action");
    const actionOutput = await runner.invoke(strategyEvent("bar", { requestId: "stateful-bar" }));
    assert.deepEqual(actionOutput, openLongAction({ metadata: { availableMarginUsdt: 9_500 } }));
    const staleBar = strategyEvent("bar", { requestId: "stateful-stale-bar" });
    staleBar.event.asOfMs = btcBars[0].closeTimeMs;
    staleBar.event.bar = staleBar.event.market.series[0].bars[0];
    staleBar.event.market.series[0].bars = [staleBar.event.bar];
    await assert.rejects(
      () => runner.invoke(staleBar),
      (error) => error instanceof PythonStrategyProtocolError && error.code === "out_of_order_event"
    );
    const closeOutput = await runner.invoke(strategyEvent("bar", {
      requestId: "stateful-close-held-position",
      portfolio: simulatedPortfolio({ positions: [simulatedLongPosition] })
    }));
    assert.deepEqual(closeOutput, {
      kind: "action",
      asOfMs: cutoffMs,
      instrumentId: "BTC-USDT-SWAP",
      action: "close_long",
      reason: "close the simulated long after confirmation"
    });

    const immutableContextSource = "def on_bar(ctx):\n    ctx.portfolio.cash_usdt = 1\n    return ctx.no_action()\n";
    await runner.load(immutableContextSource);
    await assert.rejects(
      () => runner.invoke(strategyEvent("bar", { requestId: "immutable-context" })),
      (error) => error?.code === "runtime_error"
    );

    const missingAttributeSource = "def on_bar(ctx):\n    return ctx.no_action(str(ctx.params.missing_parameter))\n";
    await runner.load(missingAttributeSource);
    await assert.rejects(
      () => runner.invoke(strategyEvent("bar", { requestId: "missing-context-attribute" })),
      (error) => error?.code === "runtime_error"
        && /AttributeError: missing_parameter/.test(error.message)
        && !/NameError/.test(error.message)
    );

    const rawFutureRequest = strategyEvent("bar", { requestId: "raw-future-bar" });
    rawFutureRequest.event.market.series[0].bars[1].closeTimeMs = cutoffMs + 60_000;
    rawFutureRequest.event.bar = rawFutureRequest.event.market.series[0].bars[1];
    const rawInjectedMarketField = strategyEvent("bar", { requestId: "raw-injected-market-field" });
    rawInjectedMarketField.event.market.series[0].bars[1].nextClose = 999;
    const invalidActionSource = [
      "def on_bar(ctx):",
      "    return {",
      "        'kind': 'action',",
      `        'asOfMs': ${cutoffMs},`,
      "        'instrumentId': 'BTC-USDT-SWAP',",
      "        'action': 'open_long',",
      "        'quantity': 1,",
      "        'reason': 'invalid direct runtime output',",
      "        'accountId': 'not-permitted',",
      "    }"
    ].join("\n");
    const forbiddenDynamicSource = [
      "def on_bar(ctx):",
      "    return getattr(ctx.portfolio, 'equity_usdt', 0)"
    ].join("\n");
    const rawMessages = [
      {
        protocol: PYTHON_STRATEGY_PROTOCOL,
        type: "load",
        requestId: "raw-load-stateful",
        source: validStatefulSource
      },
      strategyEvent("start", { requestId: "raw-start" }),
      strategyEvent("start", { requestId: "raw-duplicate-start" }),
      rawFutureRequest,
      rawInjectedMarketField,
      {
        protocol: PYTHON_STRATEGY_PROTOCOL,
        type: "load",
        requestId: "raw-load-30m-macd-protection",
        source: validThirtyMinuteMacdProtectionSource
      },
      {
        protocol: PYTHON_STRATEGY_PROTOCOL,
        type: "load",
        requestId: "raw-load-invalid-output",
        source: invalidActionSource
      },
      strategyEvent("bar", { requestId: "raw-invalid-output" }),
      {
        protocol: PYTHON_STRATEGY_PROTOCOL,
        type: "load",
        requestId: "raw-load-forbidden-dynamic-api",
        source: forbiddenDynamicSource
      },
      {
        protocol: PYTHON_STRATEGY_PROTOCOL,
        type: "shutdown",
        requestId: "raw-shutdown"
      }
    ];
    const rawOutput = await runRawRuntime(path.resolve(testPython), rawMessages);
    assert.equal(rawOutput[0].type, "ready");
    assert.equal(rawOutput[1].type, "loaded");
    assert.equal(rawOutput[2].type, "result");
    assert.equal(rawOutput[3].code, "invalid_lifecycle");
    assert.equal(rawOutput[4].code, "future_data");
    assert.equal(rawOutput[5].code, "unknown_field");
    assert.equal(rawOutput[6].type, "loaded");
    assert.equal(rawOutput[7].type, "loaded");
    assert.equal(rawOutput[8].code, "unknown_field");
    assert.equal(rawOutput[9].code, "forbidden_api");
    assert.match(rawOutput[9].message, /^line 2: getattr is not permitted; use documented fixed fields directly, for example position\.averageEntryPrice$/);
    assert.equal(rawOutput[10].type, "shutdown");

    // `hostValidated` fast path: the runtime trusts the host's field-level
    // checks (an injected unknown field is accepted), but the future-data and
    // time-monotonicity invariants are still enforced.
    const fastFieldRequest = strategyEvent("bar", { requestId: "fast-injected-field" });
    fastFieldRequest.event.hostValidated = true;
    fastFieldRequest.event.market.series[0].bars[1].nextClose = 999;
    const fastFutureRequest = strategyEvent("bar", { requestId: "fast-future-bar" });
    fastFutureRequest.event.hostValidated = true;
    fastFutureRequest.event.market.series[0].bars[1].closeTimeMs = cutoffMs + 60_000;
    fastFutureRequest.event.bar = fastFutureRequest.event.market.series[0].bars[1];
    const fastOutOfOrderRequest = strategyEvent("bar", { requestId: "fast-out-of-order" });
    fastOutOfOrderRequest.event.hostValidated = true;
    // Move the whole event back in time (bars included) so only the runtime's
    // monotonicity check, not the future-data guard, can fire against the
    // already-dispatched cutoff.
    fastOutOfOrderRequest.event.asOfMs = cutoffMs - 60_000;
    fastOutOfOrderRequest.event.market.series[0].bars[1].closeTimeMs = cutoffMs - 60_000;
    fastOutOfOrderRequest.event.bar = fastOutOfOrderRequest.event.market.series[0].bars[1];
    const fastOutput = await runRawRuntime(path.resolve(testPython), [
      {
        protocol: PYTHON_STRATEGY_PROTOCOL,
        type: "load",
        requestId: "raw-load-fast-path",
        source: validBarSource
      },
      fastFieldRequest,
      fastFutureRequest,
      fastOutOfOrderRequest,
      {
        protocol: PYTHON_STRATEGY_PROTOCOL,
        type: "shutdown",
        requestId: "raw-shutdown-fast-path"
      }
    ]);
    assert.equal(fastOutput[0].type, "ready");
    assert.equal(fastOutput[1].type, "loaded");
    assert.equal(fastOutput[2].type, "result", "hostValidated field-level shape errors must be trusted");
    assert.equal(fastOutput[3].code, "future_data", "hostValidated future bars must still be rejected");
    assert.equal(fastOutput[4].code, "out_of_order_event", "hostValidated backward time must still be rejected");
    assert.equal(fastOutput[5].type, "shutdown");
  } finally {
    await runner.close();
  }
  process.stdout.write("[systematic] Python runner smoke passed\n");
} else {
  process.stdout.write("[systematic] protocol validation passed; set DESIC_SYSTEMATIC_TEST_PYTHON to run the bundled-runtime smoke\n");
}
