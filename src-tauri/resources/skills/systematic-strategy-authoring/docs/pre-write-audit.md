# Mandatory Pre-Write Source Audit

Load this document before every source creation or change. Audit the entire
current editor buffer against every item below.

For an explanation-only request, report material errors without editing. For a
source creation or change request, fix every discovered error in the one
replacement file. Do not preserve known-invalid code merely because it was
already present.

## Checklist

1. **Method names and signatures.** Each `ctx.` call is one of the published
   methods in `docs/actions.md` and uses its exact signature. Open and close
   actions accept only the required string `reason` positionally; they never
   accept a quantity. Use named keyword arguments for `protection`, `execution`,
   and `metadata`. `ctx.open_long_limit`, `ctx.open_short_limit`,
   `ctx.close_long_limit`, and `ctx.close_short_limit` do not exist.

2. **Limit execution shape.** A limit must use the standard action with a named
   execution object, for example
   `ctx.open_long(reason, execution=ctx.limit_order(limit_price))`. The same form
   applies to opening short positions and closing either side.

3. **Protection keys.** `protection` is only for `open_long` or `open_short` and
   must be a dictionary containing one or both exact, case-sensitive, camelCase
   positive absolute-price keys: `{"stopLossPrice": price, "takeProfitPrice":
   price}`. Reject and repair snake_case mapping keys including `stop_loss`,
   `take_profit`, `stop_loss_price`, and `take_profit_price`; mappings are not
   converted automatically. Never pass a number, string, list, tuple, boolean,
   `None`, or a `ctx.set_protection(...)` result as `protection`. Change an
   existing position's protection only with `ctx.set_protection(reason,
   stop_loss_price=..., take_profit_price=...)`.

4. **Host-owned protective exits.** For ATR, percentage, break-even, trailing,
   take-profit, or stop-loss behavior, prefer host-owned entry protection. Do not
   inspect a completed higher-timeframe bar's `high` or `low` and return a manual
   limit close to claim an intrabar protective fill. A strategy exit signal
   remains a separate close action.

5. **Higher-timeframe confirmation.** For a higher-timeframe signal, ensure the
   final bar is `confirmed=True` before it affects indicators, volume, entries,
   exits, or protection. `on_bar` still runs every confirmed 1m close.

6. **Open-order hygiene.** Before placing, replacing, or cancelling a normal
   limit order, inspect `ctx.portfolio.open_orders`. Do not emit duplicate entry
   or close instructions while an applicable order remains open; use its exact ID
   with `ctx.cancel_order` when cancellation is intended. A long-only strategy
   must also avoid opening long while a short position exists.

7. **Decision completeness.** Validate that prices are finite positive absolute
   prices, that source uses only present/past data, and that the final function
   returns exactly one action or `ctx.no_action(...)` on every reachable decision
   path. The host owns contract count, minimum-size, lot-size, budget, and
   full-close rules.

8. **Field spelling.** Every portfolio, position, and bar field matches
   `docs/context.md` exactly. No `getattr`, guessed alias, or compatibility
   helper wraps a published field.

## Why static audit is required

Inspect every reachable and conditional return branch, not only the paths a
fixture happens to execute.

`strategy_testCurrentSource` runs bounded fixtures that do not force an entry or
exit signal. A conditional `open_long` branch with an invalid protection key can
remain runtime-unreached and still pass the test, then fail only when a
historical backtest finally reaches that branch.

A passing runtime test therefore never replaces this complete static source
audit. Perform both.

## Source quality and boundaries

Start changed source with a concise comment block describing premise, required
lookback, entries, and exits or position management. Add brief comments before
non-obvious calculations and decision branches, in the requested interface
language.

Keep decisions current-time bounded: do not use future bars, wall-clock time,
file or network APIs, subprocesses, dynamic evaluation, credentials, exchange
clients, or direct order calls.

Never use dynamic field probing or reflection. Access the published fields
directly and do not call `getattr`, `setattr`, `delattr`, `dir`, `vars`,
`globals`, `locals`, `eval`, `exec`, `compile`, `__import__`, `open`, `input`,
`help`, or `breakpoint`.

Preserve useful source behavior unless the user asks to replace it.
