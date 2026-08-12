# Research Workflow

Load this document before creating a strategy, saving a version, inspecting
local data, running a backtest, or starting parameter research.

None of these tools can enable a Profile, change an existing Profile, or submit
an order.

## Local data first

Use `strategy.inspectDataCoverage` before drawing any conclusion from a
historical range. Use `strategy.sampleMarketData` only for bounded local 1m
evidence. Neither tool reaches the network, an account, or credentials.

Do not reason about a range whose coverage you have not checked. Missing or gapped
local candles change what a backtest result means.

## Versions are immutable

A new strategy is created with `strategy.create`. Every later
`strategy.saveVersion` creates an immutable version and never overwrites a prior
one.

`strategy.rollbackVersion` never deletes history: it creates a new current
version containing the exact source and parameters of an earlier snapshot.

Use `strategy.listVersions` and `strategy.getVersion` to read what a version
actually contains before you compare or roll back.

## Backtests

Run `strategy.backtest` only against a saved version, never against an unsaved
buffer. Then call `strategy.getBacktestResult` with a bounded wait.

The host polls without consuming model turns and returns immediately at a
terminal state. If the bounded wait times out, call it again in the same turn
until the run completes, fails, or is cancelled. Do not hand the wait back to the
user.

A better return alone is not enough to prefer a version. Compare drawdown, fees,
trade count, source version, instrument, and data snapshot together. Use
`strategy.getBacktestTrades` for a bounded fill/trade sample,
`strategy.getBacktestDiagnostics` for frozen request and identity metadata, and
`strategy.compareBacktests` for a snapshot-compatibility-aware comparison.

Report a comparison as inconclusive when the two runs do not share a compatible
data snapshot.

## Parameter research

Use `strategy.optimize` only when the saved version declares desktop-owned tuning
ranges. Source cannot declare its own optimizer eligibility.

Optimization uses a fixed 70/30 train-validation split. Read
`strategy.getOptimizationResult` before choosing a candidate, and judge a
candidate on validation behavior rather than train-side ranking alone.

## Boundaries

These research tools read and write only local strategy records, local candles,
and host-owned backtest results. They never access files, a shell, the network,
an account, or credentials, and they never enable a Profile or place an order.
