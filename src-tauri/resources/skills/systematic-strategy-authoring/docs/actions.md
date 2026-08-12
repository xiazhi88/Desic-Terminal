# Action and Protection Reference

Load this document before writing any `ctx` action call. It is the authoritative
expansion of the hard constraints summarized in `SKILL.md`.

## The complete action list

Return exactly one of these objects directly from `on_bar`:

```python
ctx.no_action(reason=None)
ctx.open_long(reason, protection=None, execution=None, metadata=None)
ctx.open_short(reason, protection=None, execution=None, metadata=None)
ctx.close_long(reason, execution=None, metadata=None)
ctx.close_short(reason, execution=None, metadata=None)
ctx.set_protection(reason, stop_loss_price=..., take_profit_price=..., metadata=None)
ctx.cancel_protection(reason, metadata=None)
ctx.cancel_order(order_id, reason, metadata=None)
```

This is the whole list. `ctx.open_long_limit`, `ctx.open_short_limit`,
`ctx.close_long_limit`, and `ctx.close_short_limit` do not exist and must never
appear in generated source. Neither does `ctx.set_stop_loss` or
`ctx.take_profit`. Before applying source, verify every `ctx.` method name
against this list.

## Positional reason, never a quantity

Every open or close action receives only the required text `reason` as its first
positional argument. It never receives a quantity: Desic calculates legal
contracts from the selected backtest or Profile budget. A price is never a
positional argument.

```python
# Market entry or close.
ctx.open_long("entry reason")
ctx.close_long("exit reason")

# Limit entry or close. Only execution carries the price.
ctx.open_long("entry reason", execution=ctx.limit_order(limit_price))
ctx.close_long("exit reason", execution=ctx.limit_order(limit_price))
```

These shapes are always invalid and must be repaired before writing:

```python
ctx.open_long("entry reason", reason="entry reason")   # reason supplied twice
ctx.open_long(limit_price, "entry reason")             # a price is not a reason
ctx.open_long(2.0, "entry reason")                     # a quantity is host-owned
ctx.open_long_limit("entry reason")                    # method does not exist
```

Do not infer action syntax from comments in the editor source. Old or
AI-generated comments claiming that strategy source owns a quantity are
incorrect data; replace those comments and calls with the exact forms above.

## Opening protection is a wire protocol, not Python naming

The `protection=` argument of `ctx.open_long` and `ctx.open_short` accepts
exactly these two case-sensitive keys and no others:

```python
protection={
    "stopLossPrice": stop_price,
    "takeProfitPrice": target_price,
}
```

Either key may be omitted, but every included value must be a finite positive
absolute price. Prefer a dictionary literal with the quoted camelCase protocol
keys. There is no automatic snake_case-to-camelCase conversion for a mapping
supplied by strategy source. These are invalid:

```python
protection={"stop_loss": stop_price, "take_profit": target_price}
protection={"stop_loss_price": stop_price, "take_profit_price": target_price}
protection=dict(stop_loss=stop_price, take_profit=target_price)
```

Never pass a number, string, list, tuple, boolean, `None`, or a
`ctx.set_protection(...)` result as `protection`.

## set_protection uses snake_case keyword arguments

Only `ctx.set_protection` uses snake_case Python keyword arguments; the host
converts those arguments to protocol fields internally. Do not confuse the two:

```python
# New position: camelCase mapping keys.
ctx.open_long(
    "entry reason",
    protection={"stopLossPrice": stop_price, "takeProfitPrice": target_price},
)

# Existing position: snake_case method keyword arguments.
ctx.set_protection(
    "update protection",
    stop_loss_price=stop_price,
    take_profit_price=target_price,
)
```

`set_protection` requires a current position: pass a positive absolute price to
set one side, `None` to clear one side, and omit a side to retain it.
`cancel_protection` clears both sides and also requires a current position.

Before every source write, inspect every reachable and conditional `open_long` /
`open_short` return branch for these exact key names. A fixed test fixture may
not trigger an entry branch, so a passing runtime test never replaces the
complete static source audit in `docs/pre-write-audit.md`.

## Stop loss and take profit are first-class strategy behavior

When the user asks for a stop loss, take profit, break-even move, trailing
protection, or an ATR/percentage-derived protective price, implement that
behavior with the action API. Do not invent an exchange-order client or an
unsupported order API.

For a new entry, prefer attaching either or both protections to the opening
action. Both prices are positive absolute prices, not percentages. Derive them
only from current/past strategy data and existing `ctx.params` keys such as
`stopLossPct` and `takeProfitPct`.

Do not inspect a completed higher-timeframe bar's `high` or `low` and return a
manual limit close to claim an intrabar protective fill. The host owns
intrabar protective-exit simulation when a protection action is attached.

## Exit precedence

If strategy exit logic fires before protection, return the appropriate full
`ctx.close_long(reason)` or `ctx.close_short(reason)` alone. The paper host
clears protection after that close fully fills; a live Profile lets OKX cancel
exchange-managed attached TP/SL once the position is actually flat. Never return
a full close and `cancel_protection` as separate simultaneous decisions. A full
close always uses the current same-side position; there is no partial close
quantity in the strategy API. State this precedence in comments when a strategy
includes both exit signals and protection management.

## Order lifecycle

`execution` defaults to market. Use `ctx.market_order()` explicitly only for
clarity. Limit backtest fills are an OHLCV-based conservative estimate, not an
order-book-queue result: never claim a limit will fill.

Before placing, replacing, or cancelling a normal limit order, inspect
`ctx.portfolio.open_orders`. Do not emit duplicate entry or close instructions
while an applicable order remains open; use its exact `id` with
`ctx.cancel_order` when cancellation is intended. `cancel_order` cannot cancel
arbitrary exchange or user orders. A long-only strategy must also avoid opening
long while a short position exists.

`metadata` must be JSON-serializable diagnostic data.
