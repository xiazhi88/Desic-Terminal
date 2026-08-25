# Context, Market, and Portfolio Reference

Load this document when a strategy reads bars, parameters, positions, orders, or
ledger data. Access every published field directly; the sandbox rejects dynamic
field probing.

## Lifecycle

The source must define synchronous `def on_bar(ctx):`. It runs after every
confirmed one-minute K-line close and must return exactly one decision.

`def on_start(ctx):` is optional and runs once for initialization; the current
historical adapter must receive `ctx.no_action(...)` from it, never a trade
action.

There is no `on_fill` callback: read completed simulated fills from
`ctx.portfolio.recent_fills` inside `on_bar` when the strategy needs them.

Ordinary helper functions may use any sensible names and arguments; the host
never calls them automatically. Handlers must stay synchronous and keep their
exact signatures.

## The current event

`ctx.as_of_ms`, `ctx.snapshot_id`, `ctx.kind`, `ctx.instrument_id`, and
`ctx.interval` describe the immutable current-time event. `ctx.bar` is the active
Bar during `on_bar`.

## Cross-sectional factor scores

`ctx.factor_scores(factor_id)` returns a read-only mapping of instrument id to a
row exposing `score`, `rank`, `universeSize`, and `asOfMs`. It reports where an
instrument stands against the rest of the universe, which no single-instrument
field can express.

```python
scores = ctx.factor_scores("builtin-kline-blend-v1")
mine = scores.get(ctx.instrument_id)
if mine and mine["rank"] <= 10:
    return ctx.open_long("top-10 cross-sectional score")
```

Three rules, all enforced:

- **The factor id must be a string literal.** The host precomputes each named
  cross-section before the first event, so a computed identifier is refused when
  the source loads. Unlike `interval`, there is no safe fallback set to preload.
- **Reading a score is not a decision.** It produces no action and places no
  order; the action methods remain the only way to trade.
- **An empty mapping means unknown, not zero.** The host omits a cross-section
  when the universe was too thin to rank or its snapshot went stale. Decide
  explicitly what the strategy does in that case rather than treating a missing
  entry as a neutral score.

A ranking over very few instruments carries little information, so check
`universeSize` before gating on `rank`.

A Bar exposes `openTimeMs`, `closeTimeMs`, `open`, `high`, `low`, `close`,
`volume`, and `confirmed`, read directly as `bar.close`. All `1m` bars are
confirmed.

## Market series

```python
ctx.market.bars(instrument_id, interval, lookback=None)
```

Returns an immutable, time-ascending sequence of Bar objects. `instrument_id` is
normally `ctx.instrument_id`. `interval` must be one of `1m`, `3m`, `5m`, `15m`,
`30m`, `1H`, `2H`, `4H`, `6H`, `12H`, `1D`. `lookback` is an optional positive
integer that returns only the final N bars.

The canonical request is:

```python
bars = ctx.market.bars(ctx.instrument_id, interval="1m", lookback=240)
```

A higher-timeframe series can end with exactly one in-progress bar marked
`confirmed=False`. Its OHLCV contains only minutes known at the current event and
must never be used as a closed-bar confirmation. Use the preceding bar when a
confirmed higher-timeframe signal is required.

An unavailable series raises `KeyError`; an invalid lookback raises `ValueError`.

## Parameters

`ctx.params` is a read-only mapping of only the saved parameter keys. Use
`ctx.params["key"]` or `ctx.params.get("key", default)`.

The desktop presents top-level scalar parameters visually: numbers, text, and
switches. Use them for periods, signal intervals, stop-loss percentages,
take-profit percentages, and other stable strategy settings.

Never invent parameter keys, alter parameter JSON, or declare optimization
eligibility in source. The user can later select platform-eligible numeric
parameters and set only their minimum, maximum, and step for optimization.
Sizing is host-owned: saved strategy parameters must not carry an opening
contract count.

## Portfolio

`ctx.portfolio` is an immutable virtual-account snapshot exposing `cash_usdt`,
`equity_usdt`, `used_margin_usdt`, `available_margin_usdt`, `positions`,
`open_orders`, `recent_fills`, and `trades`.

Position access:

```python
long_position = ctx.portfolio.position(ctx.instrument_id, "long")
both_sides = ctx.portfolio.positions_for(ctx.instrument_id)
```

`ctx.portfolio.position(instrument_id, side)` is a method and must be called with
both arguments; it is not a `position` property. `ctx.position(...)` is an alias.
It returns a Position or `None`. `positions_for` returns a tuple, and
`ctx.portfolio.positions` is an immutable tuple of active Position objects.

A Position has `instrumentId`, `side`, `quantity`, `averageEntryPrice`,
`markPrice`, `contractValue`, `notionalUsdt`, `usedMarginUsdt`, `leverage`,
`marginSafetyMultiplier`, `unrealizedPnlUsdt`, `entryFeeUsdt`,
`fundingCashflowUsdt`, `stopLossPrice`, `takeProfitPrice`, `openedAtMs`, and
`updatedAtMs`.

A Position's size field is `quantity`, never `contracts`, `contractCount`, or
`size`; contract sizing belongs to the host.

`open_orders` holds only current normal strategy orders. Each item exposes `id`,
`instrumentId`, `action`, `quantity`, `filledQuantity`, `status` (`open` or
`partially_filled`), `createdAtMs`, and optional `price`.

Fill and closed Trade records are read-only current/past ledger data.

## Field access discipline

Use these names directly: write `position.averageEntryPrice`, never
`getattr(position, "averageEntryPrice", ...)` or a guessed alias. Do not add
compatibility helpers around published fields.

The strategy sandbox rejects `getattr`, `setattr`, `delattr`, `dir`, `vars`,
`globals`, `locals`, `eval`, `exec`, `compile`, `__import__`, `open`, `input`,
`help`, `breakpoint`, and dunder access.

## Multi-timeframe scheduling and the execution clock

`on_bar` is always scheduled after a confirmed one-minute close. A strategy whose
signal interval is `30m` still receives one-minute callbacks. Reading a `30m`
series changes the data, not the callback clock.

If the user requests decisions only after a 30-minute close, obtain the `30m`
series and return `ctx.no_action(...)` whenever its newest bar has
`confirmed=False`. Calculate MACD, volume, ATR, and entry/exit conditions only
when that newest 30m bar is confirmed. Never claim that `on_bar` itself runs
every 30 minutes or treat an in-progress 30m bar as a closed signal.

A market action fills at the following one-minute open. A limit action becomes
pending at that open and may fill later, partially fill, be cancelled, or expire.

Attach initial protection to the opening action so the host can monitor it on
every following one-minute bar. A later `ctx.set_protection(...)` may align a
bracket to `position.averageEntryPrice` after the fill becomes visible.

The host applies fees and slippage, limits simulated limit-order participation to
a conservative share of later 1m volume, and owns virtual-margin exhaustion
handling. Do not promise a fill in source comments or user-facing explanations.
