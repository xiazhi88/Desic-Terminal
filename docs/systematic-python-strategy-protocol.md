# Systematic Python Strategy Protocol

This document defines the private protocol between Desic Terminal and its local Python runtime. It is a versioned strategy-decision contract: Python never receives an exchange client or order API. A separately owned Profile executor may translate a validated decision into an audited terminal order after explicit activation.

## Runtime Boundary

Desic owns the clock, market snapshot, virtual account, matching, risk checks, and audit trail. A Python strategy receives one immutable current-time snapshot and returns one high-level strategy decision. It never receives an OKX client, account key, system clock, database handle, network service, filesystem path, subprocess API, or arbitrary data-query API.

The JSONL protocol version remains `desic.systematic.python/v1`. Parent and child exchange one JSON object per line. The host validates every request before dispatch and every result before it reaches a backtest or simulation engine.

Events the host itself serialises carry a top-level `hostValidated: true` marker. It declares that the host has already performed the field-level, chronology, and cutoff checks for every bar, portfolio row, and timestamp in the payload. For a marked event the private runtime runs only the invariants that would otherwise corrupt its own state or leak look-ahead data — `asOfMs` monotonicity, the presence and shape of the market series, and that a confirmed bar never closes after the event cutoff — and skips re-walking field-level validation on every minute of a long backtest. An event without the marker (for example an older host or a test harness) is still fully validated by the runtime. The strategy-visible contract is identical in both paths; the marker only changes how much redundant validation the runtime repeats.

For local research, Desic ships a bundled, checksum-verified CPython 3.13 runtime inside the application resources (a python-build-standalone distribution staged by the build-time prepare script) and creates an application-owned virtual environment from it when absent, falling back to a compatible Python 3.12-3.13 interpreter on `PATH` for development builds. The environment installs only the pinned dependencies associated with the source-policy allowlist. The strategy process starts with a clean Python environment and an empty private working directory. This venv isolates dependencies but is not an operating-system sandbox; static source policy is defense in depth. Only activate a Profile for source you trust and have reviewed. A future release-managed runtime should additionally use a platform-level restricted-process sandbox on macOS and Windows.

No output from this protocol is an exchange order. In particular, the runtime has no account credentials, network access, exchange API access, or direct order-placement function. The Profile executor receives the action after the Python process returns, fetches the account state itself, applies the Profile risk boundary, and then calls the existing terminal order adapter.

## Strategy Lifecycle

A strategy may define any combination of these synchronous handlers:

```python
def on_start(ctx):
    ...

def on_bar(ctx):
    ...
```

- `on_start(ctx)` runs once after a strategy version is loaded. If present, it must run before bar events. The current local historical adapter treats it as an initialization hook and requires it to return `no_action`; trade actions are emitted from `on_bar`.
- `on_bar(ctx)` runs only after the active **1-minute** bar is confirmed. `event.bar.closeTimeMs` equals `ctx.as_of_ms` and `ctx.bar.confirmed` is always `True`.
- `on_start` is optional. If absent, the runtime produces a current-time `no_action`; `on_bar` remains required for a bar strategy.

New strategy source must not define `on_fill`. Older saved versions that contain that unused hook remain loadable for compatibility, but no current adapter dispatches it. Read `ctx.portfolio.recent_fills` from `on_bar` when a strategy needs completed simulated fills.

The runtime dispatches a single strategy time line serially. Independent backtests can run in parallel, but one strategy cannot receive concurrent events because every decision depends on the preceding simulated account state. A loaded strategy cannot receive an event with an `asOfMs` earlier than a successfully completed prior event. During a historical backtest, the host may combine a bounded run of empty-account `no_action` events into one private JSONL request. The runtime evaluates those events in timestamp order, stops the batch at the first action, and the host then resumes normal one-minute processing before that action can affect the next bar. This is an IPC optimization only: it never changes strategy decision times, virtual fills, protection handling, ledger rows, or replay points. The host starts batching only after a long direct empty-account `no_action` streak and disables it for the remainder of a run when a batch produces an action, so active strategies retain the lower-overhead single-event path. At load time the runtime statically reports literal `ctx.market.bars` intervals; the host transports only those series plus required `1m`. Dynamic interval expressions conservatively retain every supported series. After the first visible window, the local adapter sends only each newly closed K-line over JSONL and the runtime retains a bounded 20,000-bar current/past cache, so a long backtest does not resend its complete history per minute. Portfolio cash, equity, and positions remain full point-in-time fields; the bounded visible fill and trade ledgers begin as a replacement snapshot and subsequently transport only newly appended records. Before user code runs, the runtime reconstructs an immutable ledger snapshot with the same current-time contents.

`ctx.market.bars(ctx.instrument_id, interval, lookback=None)` supports `1m`, `3m`, `5m`, `15m`, `30m`, `1H`, `2H`, `4H`, `6H`, `12H`, and `1D`. The 1-minute series is fully confirmed. A higher-timeframe series can end with exactly one active, incomplete bucket: it has `confirmed=False`, an `openTimeMs` before `ctx.as_of_ms`, and a nominal `closeTimeMs` after it. Its OHLCV contains only minutes already known at the current callback, never future minutes. Strategies may use such a bar for a developing-value rule, but must require `bar.confirmed` before treating it as a higher-timeframe confirmation. No series can contain an unconfirmed bar anywhere except its final item.

## Preloaded History and Evaluation Boundary

`preloadBars` is the count of confirmed 1-minute bars loaded strictly before a backtest's formal evaluation start. For an evaluation start `S` and `N` preloaded bars, the host requires the exact contiguous interval `[S - N minutes, S)`, followed by the requested evaluation interval. It fails closed when any preloaded or evaluation bar is absent; it never substitutes bars from inside the evaluation range.

The last preloaded bar closes exactly at `S`. It supplies the first current-time strategy context, so a decision at that cutoff may be queued and fill at the first evaluation bar open. In a Python package with `on_start`, that initialization hook and its first `on_bar` both receive this boundary context; the runtime sends the full preloaded history once and then incrementally appends confirmed bars. The runtime keeps its bars in immutable point-in-time snapshots, so a strategy that retains an earlier market view cannot observe a later bar while long backtests avoid reconstructing the complete history on every event.

Preloaded bars are context only. They never produce equity points, replay snapshots, PnL, drawdown, exposure, trade statistics, or report-time candle playback. The formal result starts with the bar opened at `S`; its first equity snapshot is taken after any queued boundary decision has been simulated at that bar's open.

## Immutable Context

All fields exposed through `ctx` are read-only. Attempting to assign to context, market, portfolio, position, bar, or ledger fields fails the invocation.

```python
def on_bar(ctx):
    bars = ctx.market.bars(ctx.instrument_id, ctx.interval, lookback=2)
    long_position = ctx.portfolio.position(ctx.instrument_id, "long")

    if long_position is not None:
        return ctx.close_long("exit after closed-bar confirmation")

    if bars[-1].close > bars[0].close:
        return ctx.open_long(
            2.0,
            "closed-bar momentum confirmation",
            protection={"stopLossPrice": 99.0, "takeProfitPrice": 110.0},
        )
    return ctx.no_action("no confirmation")
```

`ctx` exposes:

- `as_of_ms`, `snapshot_id`, and `kind`.
- `instrument_id` and `interval` for `start` and `bar` events.
- `bar` for `on_bar`, and `market.bars(instrument_id, interval, lookback=None)` for immutable point-in-time K-line series. A higher-timeframe final item can be an explicitly unconfirmed active bucket as described above.
- `params`, an immutable mapping of the selected strategy record's saved JSON parameters. It is read as `ctx.params["fastPeriod"]` or `ctx.params.get("fastPeriod", 10)`.
- `portfolio`, a simulated-account snapshot with `cash_usdt`, `equity_usdt`, `used_margin_usdt`, `available_margin_usdt`, immutable `positions`, `open_orders`, `recent_fills`, and closed `trades`.
- `portfolio.position(instrument_id, side)` for a `long` or `short` simulated position, and `portfolio.positions_for(instrument_id)` for both sides when present.

Portfolio data is explicit and current-time bounded:

- Positions include instrument, side, quantity, average entry / mark price, contract value, notional, used margin, leverage, margin safety multiplier, unrealized PnL, current stop/take-profit values, and observed timestamps.
- Fills include an internal simulated fill ID, source order ID, action, quantity, price, notional, fee, margin change, remaining used margin, and time.
- Closed trades include entry/exit time and price, size, entry/exit notional, allocated used margin, leverage, margin safety multiplier, realized PnL, and fees.

Only the desktop-owned strategy configuration can mark a parameter as a tuning candidate. It may configure `min`, `max`, and `step` only for an existing top-level finite numeric `ctx.params` value. Python source cannot declare itself optimizer-eligible, cannot change a parameter value, and cannot add a tuning range. The host-owned optimization worker uses these saved ranges with a fixed 70/30 train-validation split and stores candidate metrics separately from immutable strategy versions.

Every timestamp in market, portfolio, fill-ledger rows, and output metadata must be no later than `ctx.as_of_ms`, except the nominal close of an explicitly unconfirmed active higher-timeframe bucket. The host rejects future bars, undeclared market fields, future ledger rows, duplicate ledger IDs, and invalid price/quantity values.

## Python API Reference

All objects below are immutable. Protocol field names are camel-case and can be accessed as Python attributes, for example `bar.close`, `position.averageEntryPrice`, and `fill.feeUsdt`. Use the published field names directly: write `position.averageEntryPrice`, never `getattr(position, "averageEntryPrice", ...)` or a guessed alias. Dynamic field probing and execution are not part of the strategy API.

### Lifecycle callbacks

| Callback | Arguments | Return | Current local historical behavior |
| --- | --- | --- | --- |
| `on_bar(ctx)` | `ctx: StrategyContext` | One action or `ctx.no_action(...)` | Required for a bar strategy; invoked after each confirmed 1-minute close. |
| `on_start(ctx)` | `ctx: StrategyContext` | `ctx.no_action(...)` | Optional; invoked once after loading for initialization only. Do not emit a trade action. |

Ordinary helper functions may be freely defined for calculations and organization. They are never called by the host automatically. Handlers must be synchronous and retain their exact signatures.

### Context and market

| API / field | Arguments or type | Returns / meaning |
| --- | --- | --- |
| `ctx.as_of_ms` | integer | Unix milliseconds for the current callback. During `on_bar`, exactly the active 1-minute `closeTimeMs`. |
| `ctx.snapshot_id` | string | Immutable point-in-time market/account snapshot ID. |
| `ctx.kind` | `start` or `bar` | Current lifecycle event kind. |
| `ctx.instrument_id`, `ctx.interval` | string | Current active instrument and event interval. The current bar adapter uses `1m`. |
| `ctx.bar` | `Bar \| None` | Active event Bar. It is populated only for `on_bar`. |
| `ctx.market.bars(instrument_id, interval, lookback=None)` | instrument ID; one of `1m`, `3m`, `5m`, `15m`, `30m`, `1H`, `2H`, `4H`, `6H`, `12H`, `1D`; optional positive integer lookback | Immutable time-ascending Bar sequence. `lookback` returns the final N items. An unavailable series raises `KeyError`; invalid lookback raises `ValueError`. |
| `ctx.indicators.ema(instrument_id, "1m", period, offset=0)` | instrument ID; confirmed `1m`; positive integer period; non-negative offset | EMA at the current bar (`offset=0`) or a preceding bar (`offset=1` is the prior bar), or `None` before `period` bars. It seeds with the simple mean of the first `period` closes, then applies `2 / (period + 1)`. The runtime caches and incrementally updates it. |
| `ctx.indicators.atr(instrument_id, "1m", period, offset=0)` | instrument ID; confirmed `1m`; positive integer period; non-negative offset | Wilder ATR at the current or an offset bar, or `None` before `period + 1` bars. True range uses current high/low and prior close; the first value is the mean of the first `period` true ranges. The runtime caches and incrementally updates it. |
| `ctx.params[key]`, `ctx.params.get(key, default)` | Saved parameter key, optional default | Immutable saved JSON parameter value. Source cannot add keys, change values, or declare tuning eligibility. |

`Bar` has `openTimeMs`, `closeTimeMs`, `open`, `high`, `low`, `close`, `volume`, and `confirmed`. All 1-minute bars are confirmed. For higher intervals, only the final item can be `confirmed=False`; its OHLCV contains only minutes known at the callback. Use the preceding item where a confirmed higher-timeframe signal is required. The v1 rolling indicator cache intentionally accepts only `1m`: higher-timeframe active buckets can be revised before confirmation and are therefore not suitable for an append-only indicator state. Retained older contexts read their historical cached indicator value; they never observe a later bar.

### Multi-timeframe signal and execution clock

`on_bar(ctx)` is dispatched after every confirmed 1-minute close, including for a strategy whose signal is calculated from `30m` data. Reading `ctx.market.bars(ctx.instrument_id, "30m", ...)` changes the data series, not the callback clock. If a strategy must act only after a 30-minute close, it must return `ctx.no_action(...)` while `bars[-1].confirmed` is `False`, and evaluate its indicators only once that final 30-minute bar is confirmed. The resulting entry, exit, or protection update is then simulated at the following 1-minute open.

For a 30-minute entry with ATR protection, attach an initial absolute-price bracket through `protection` on `ctx.open_long` or `ctx.open_short`; the simulator monitors that bracket against each following 1-minute OHLC bar. If the bracket must be exactly relative to the eventual fill price, keep the initial bracket for first-minute coverage and issue `ctx.set_protection(...)` after `position.averageEntryPrice` becomes visible. Do not inspect a 30-minute bar's `high`/`low` yourself and return a delayed close to emulate a protective fill. A market action is evaluated at the following 1-minute open. A limit action becomes a pending order at that point and may fill later, fill partially, be cancelled, or expire.

### Portfolio and ledger

| API / field | Arguments | Returns / meaning |
| --- | --- | --- |
| `ctx.portfolio.cash_usdt`, `equity_usdt` | - | Current virtual cash and account equity. |
| `ctx.portfolio.used_margin_usdt`, `available_margin_usdt` | - | Current virtual used and available margin. |
| `ctx.portfolio.positions` | - | Immutable tuple of active Position objects. |
| `ctx.portfolio.position(instrument_id, side)` | `side` is `"long"` or `"short"` | Position or `None` when the requested side is flat. `ctx.position(...)` is an alias. |
| `ctx.portfolio.positions_for(instrument_id)` | instrument ID | Immutable tuple of current positions for the instrument. |
| `ctx.portfolio.open_orders`, `recent_fills`, `trades` | - | Immutable current/past virtual instruction, Fill, and closed Trade sequences. |

`Position` fields are `instrumentId`, `side`, `quantity`, `averageEntryPrice`, `markPrice`, `contractValue`, `notionalUsdt`, `usedMarginUsdt`, `leverage`, `marginSafetyMultiplier`, `unrealizedPnlUsdt`, `entryFeeUsdt`, `fundingCashflowUsdt`, `stopLossPrice`, `takeProfitPrice`, `openedAtMs`, and `updatedAtMs`.

Common field traps are deliberate protocol errors: `ctx.portfolio.position(instrument_id, side)` is a method and must be called with both arguments; it is not a `position` property. A Position's size field is `quantity`, never `contracts`, `contractCount`, or `size`; contract sizing belongs to the host. The canonical bar request is `ctx.market.bars(ctx.instrument_id, interval="1m", lookback=240)`, and Bar fields are read directly as `bar.open`, `bar.high`, `bar.low`, `bar.close`, `bar.volume`, and `bar.confirmed`. Do not add compatibility helpers such as `getattr` or guessed aliases around these fields.

`OpenOrder` fields are `id`, `instrumentId`, `action`, requested `quantity`, `filledQuantity`, `status`, `createdAtMs`, and optional limit `price`. Its status is `open` or `partially_filled`; only an ID currently present in `ctx.portfolio.open_orders` can be passed to `ctx.cancel_order(...)`. `Fill` fields are `id`, `orderId`, `instrumentId`, `action`, `quantity`, `price`, `notionalUsdt`, `filledAtMs`, `feeUsdt`, `marginDeltaUsdt`, and `marginAfterUsdt`. Closed `Trade` fields are `id`, `instrumentId`, `side`, `quantity`, `entryPrice`, `exitPrice`, `entryNotionalUsdt`, `exitNotionalUsdt`, `usedMarginUsdt`, `leverage`, `marginSafetyMultiplier`, `openedAtMs`, `closedAtMs`, `realizedPnlUsdt`, and `feesUsdt`.

## Cross-Sectional Factor Scores

`ctx.factor_scores(factor_id)` returns the host-computed cross-section for one
factor at the current cutoff, as a read-only mapping of instrument id to a row
exposing `score`, `rank`, `universeSize`, and `asOfMs`. It answers "where does
this instrument rank against the rest of the universe right now", which a
single-instrument view cannot express.

```python
def on_bar(ctx):
    scores = ctx.factor_scores("factor-abc")
    mine = scores.get(ctx.instrument_id)
    if mine and mine["rank"] <= 10:
        return ctx.open_long("top-10 cross-sectional score")
    return ctx.no_action("not in the leading decile")
```

Three rules apply.

**The factor id must be a string literal.** The host computes each requested
cross-section before dispatching the first event, so it has to know the names in
advance. A dynamic expression is refused at load time rather than silently
yielding an empty mapping. This differs from `interval`, where an unprovable
expression can fall back to loading every supported series, because the set of
factor identifiers is unbounded and has no safe superset.

**Reading a score is not an action.** This call produces no decision and places
no order. Trading still happens only through the action methods below, so factor
access cannot widen what a strategy is permitted to do.

**An empty mapping means no information.** The host omits a cross-section when
the universe was too thin to rank or the snapshot had gone stale. Treat a missing
entry as unknown rather than as a score of zero, and decide explicitly what the
strategy does in that case.

Scores never carry a timestamp later than `event.asOfMs`; the runtime rejects the
event if one does.

## Strategy Decisions

New strategy packages return exactly one of these forms for `on_start` or `on_bar`:

```python
ctx.no_action("optional audit reason")
ctx.open_long(reason, protection=None, execution=None, metadata=None)
ctx.open_short(reason, protection=None, execution=None, metadata=None)
ctx.close_long(reason, execution=None, metadata=None)
ctx.close_short(reason, execution=None, metadata=None)
ctx.set_protection(reason, stop_loss_price=..., take_profit_price=..., metadata=None)
ctx.cancel_protection(reason, metadata=None)
ctx.cancel_order(order_id, reason, metadata=None)
```

Action results use this JSON shape:

```json
{
  "kind": "action",
  "asOfMs": 1700000120000,
  "instrumentId": "BTC-USDT-SWAP",
  "action": "open_long",
  "reason": "closed-bar momentum confirmation",
  "execution": { "orderType": "limit", "limitPrice": 100.0 },
  "protection": {
    "stopLossPrice": 99,
    "takeProfitPrice": 110
  }
}
```

Open and close actions do not carry a contract count. They receive only the required audit `reason` as their first positional argument; the host derives a legal count from the backtest or Profile sizing budget and instrument rules. Every optional field must use its explicit keyword. In particular, never place a limit price in the second position. `execution` is optional on an opening or closing action and defaults to `ctx.market_order()`, equivalent to `{ "orderType": "market" }`. The only other supported form is `ctx.limit_order(limit_price)`, equivalent to `{ "orderType": "limit", "limitPrice": positive_absolute_price }`. Apply a limit execution to the standard action, for example `ctx.open_long(reason, execution=ctx.limit_order(limit_price))`. `open_long_limit`, `open_short_limit`, `close_long_limit`, and `close_short_limit` do not exist. `set_protection`, `cancel_protection`, and `cancel_order` do not have a quantity. `cancel_order` must name an order currently visible in `ctx.portfolio.open_orders`. When a simulated portfolio is supplied, a close action must match its current long/short position and always closes that side. Output cannot include account IDs, exchange order IDs other than an eligible `cancel_order` reference, API data, arbitrary order fields, future equity curves, or unvalidated payloads.

`protection` is an optional **request**, not an attached exchange order. It may contain `stopLossPrice` and/or `takeProfitPrice`, and only accompanies an opening action. `set_protection` changes either side independently: omit a field to retain it, pass `None` to remove it, or pass a positive absolute price to replace it. `cancel_protection` removes both sides. A full close or side flip removes attached protection automatically after that simulated close has fully filled; a partial close retains it unless a later action changes or cancels it.

Every action is decided at a confirmed 1-minute close. A market action fills at the following 1-minute open using the backtest fee and slippage model. A limit action becomes open at that next open, then checks later 1-minute OHLCV bars. It is deliberately a conservative K-line estimate: a buy requires a strictly better traversal below its limit, a sell requires a strictly better traversal above its limit, and the engine caps all strategy limit fills on a bar to 10% of that bar's volume. The simulator has no historical order-book queue, so it must never be read as a promise of exchange fill order, latency, or liquidity. Pending orders remain visible through `ctx.portfolio.open_orders`, can fill in parts, can be cancelled on a subsequent callback, and expire when the run ends.

For an enabled Profile, this release supports `no_action`, `open_long`, `open_short`, `close_long`, `close_short`, and `cancel_order`. Opening and closing actions may use either market or limit execution. Entry protection is sent as an attached native TP/SL request with the opening order. Profile configuration exposes market or trigger-after-limit protection execution only for stop-loss/take-profit sides statically declared by the pinned strategy source; take-profit additionally supports a post-fill resting limit, which is submitted immediately after actual entry fills and resized as partial fills arrive. It never creates a missing side. Desic records only that a close request was accepted; it does not manually remove attached TP/SL on that acknowledgement, because acceptance is not fill proof. Once the position is actually fully flat, exchange-managed attached TP/SL is cancelled by OKX. Before a Profile strategy close is submitted, Profile-owned post-fill resting TP orders are cancelled and marked superseded so the reconciliation loop cannot recreate them. Dynamic `set_protection` and `cancel_protection` are deliberately blocked for live Profiles until native amendment/reconciliation is implemented; they remain fully available in backtests. A Profile never treats an unfilled strategy action and its protection as a single opaque execution result.

## Virtual Margin and Backtest Defaults

Each backtest records a leverage from 1x through 50x (default 10x) and a margin safety multiplier from 1x through 20x (default 1x). Opening a virtual position reserves `notional / leverage * safety multiplier` from virtual equity. The strategy sees the resulting `used_margin_usdt` and `available_margin_usdt` but cannot alter those assumptions.

This is deliberately a conservative virtual-margin rule, not an exchange liquidation-price model. When an opening gap or adverse intrabar extreme exhausts the simulated collateral, the backtest closes the virtual position at the conservative available price and records `marginExhaustion`. It must be read as a research risk boundary, never as an OKX liquidation estimate or live-execution guarantee.

The backtest form defaults the formal evaluation end to the latest local confirmed minute that is at least one hour behind the current time, and the start to 30 days earlier. The same one-hour delay is the latest selectable end for a manual backtest or parameter optimization. `preloadBars` remains earlier-only context and is excluded from evaluation as described above.

Legacy research-only `signal`, `paper_intent`, and `on_rebalance` factor outputs remain accepted for existing Desic fixtures and records. New strategy packages must use the action API above. Factor research remains a separate advanced workflow: `on_rebalance(ctx)` may return transparent factor, alpha, or portfolio-target research output but cannot create strategy actions or exchange orders.

## Source Policy

Before launch, the Node host and private runtime statically validate strategy source. Allowed import roots are `collections`, `dataclasses`, `math`, `numpy`, `pandas`, `sklearn`, `statistics`, and `typing`. Filesystem, network, subprocess, dynamic import/evaluation, dunder access, classes, async handlers, generators, and unsupported imports are rejected. The dynamic or host-access built-ins `getattr`, `setattr`, `delattr`, `dir`, `vars`, `globals`, `locals`, `eval`, `exec`, `compile`, `__import__`, `open`, `input`, `help`, and `breakpoint` are also rejected. Access a field from the API reference directly instead of testing possible field spellings at runtime.

Handlers must have the exact signatures shown above. They are synchronous. A strategy version may keep ordinary Python module state across its own serial event timeline, but it cannot mutate the supplied context or access any host resource beyond its snapshot.

This source policy and the local venv are not a security boundary by themselves. The process still receives no credential, proxy, account, or order capability, but a future execution runtime should additionally prohibit network sockets, arbitrary file access, process creation, credential access, and external IPC with a platform-level sandbox, even if a package dependency or language-runtime escape is discovered.

## Desktop Status

User-authored Python strategy execution is available for local historical backtests after the research panel prepares its environment:

- On first use, Desic creates `systematic-python/venv` under the writable Desic runtime workspace from the bundled CPython runtime shipped in the application resources. The bundled runtime is a checksum-verified python-build-standalone distribution, so release users never install Python themselves.
- Development builds without a staged bundled runtime fall back to a compatible Python 3.12 through 3.13 interpreter on `PATH`; the venv layout and the pinned allowlist dependency set are identical.
- If the venv and its manifest are already present, the panel shows no setup guidance and Python backtests can run immediately. When an app update ships a newer bundled runtime, the venv is rebuilt from the new interpreter.
- If neither the bundled runtime nor a compatible system Python can be used, the panel keeps Python backtests unavailable and tells the user to install a supported version and add it to `PATH`, then recheck.
- A Python strategy always receives only the point-in-time K-line and read-only portfolio contract; it never receives account credentials, proxy settings, arbitrary data APIs, or any exchange-order function.

The older "Run Python sample" command remains a compatibility diagnostic for an interpreter selected through the native file picker. It runs only an application-owned fixture and does not choose the interpreter used by local strategy backtests.

An enabled Profile runs its pinned strategy version after each confirmed, already-subscribed 1-minute K-line close. It does not create its own market subscription. Before every invocation, Desic supplies a fresh private-account snapshot, the current positions, and up to 200 local synced fills for the selected account, environment, and contract. The Profile then accepts only the action contract above, applies its fixed account, environment, contract, cross/isolated margin mode, target leverage, directional permission, per-entry and same-side total margin budgets, daily realized-loss limit, and entry cooldown. The host resolves each opening intent into a contract count using fresh equity, the current execution price, instrument minimum and lot-size rules, and existing same-side usage.

Opening and closing actions use the terminal's normal audited WSS-first order route with a stable execution key. Before an entry, Desic checks the actual OKX leverage and synchronizes it to the fixed Profile target when necessary. Activation requires a completed backtest of that exact strategy version and contract, a local Python environment, account read and trade permissions, conflict review against enabled AI automation for the same account/environment, and an explicit confirmation every time a real-account Profile is enabled. A Profile can be stopped but never silently reconfigured while enabled. Signal history stores each action, block, order identifiers, and any execution error. A per-cycle strategy, account-snapshot, or order error is recorded for review and does not immediately stop the Profile; normal risk rules can still block the affected action. If its per-Profile notification switch and the global `strategy_signal` Feishu event are both enabled, submitted and blocked actions notify Feishu.

## Validation and Packaging

The Node entry points are [python-protocol.mjs](../scripts/systematic/python-protocol.mjs) and [python-strategy-runner.mjs](../scripts/systematic/python-strategy-runner.mjs). Run protocol validation with:

```sh
npm run test:systematic-python
```

For an explicit command-line development smoke only, set `DESIC_SYSTEMATIC_TEST_PYTHON` to the absolute path of a known interpreter. The application does not use this environment variable; it independently detects compatible Python installations on `PATH` for the local research environment.

The desktop app does not require the user to install Python. Release builds bundle a checksum-verified CPython runtime; only development builds without a staged bundle fall back to a user-installed interpreter. First-time dependency installation needs access to the configured Python package index. The fixed dependency list is [python-runtime-requirements.txt](../scripts/systematic/python-runtime-requirements.txt); all direct and transitive packages are version-pinned, but this is not a hash-verified binary supply-chain boundary.

## AI Strategy Authoring

The Strategy Research AI button opens a right-side multi-turn assistant for the currently selected Python strategy. It uses a Desic runtime-scoped research Skill rather than a one-shot code-generation prompt.

That Skill follows the standard progressive-disclosure layout. Its always-loaded `SKILL.md` carries only the scope, editor workflow, and hard action invariant; the detailed action, context, pre-write audit, and research contracts live in `docs/` beside it, with a known-valid `templates/ema-trend.py`. The assistant loads a bundled document on demand with the read-only `skill.readResource` tool, which resolves only relative paths inside that Skill's own directory. It is not a general file reader: Desic AI sessions have no filesystem or shell tools, so a Skill's `docs/` is reachable only through this validated path and its `scripts/` is never executable. Each turn can read the live unsaved editor buffer and a revision number, create local research strategies, save immutable versions, create rollback versions, inspect bounded local 1m coverage and samples, run pinned local historical backtests, compare results, and run fixed 70/30 train-validation parameter studies from desktop-owned tuning ranges. The session can access the bound strategy and strategies it creates, but not arbitrary strategies, filesystem paths, credentials, accounts, networks, Profiles, or exchange orders. `strategy.readDevelopmentDocs` remains an optional read-only reference for protocol details; source writes are independently protected by the current editor revision, source-policy validation, and the bounded Python test. The tool returns this complete, versioned document together with `documentationVersion`, `protocolVersion`, and a SHA-256 content digest when used.
For a requested editor source change, the assistant calls `strategy.applySource` with a complete replacement file and the revision it just read. The desktop rejects stale revisions, writes the accepted source into the visible editor, and reports the new revision. This editor operation is separate from `strategy.saveVersion`, which creates the next immutable version without deleting history. `strategy.rollbackVersion` copies an earlier immutable snapshot into a new current version. Switching research tabs or closing/reopening the assistant panel keeps the same stream and session; only an explicit stop action or a strategy-scope change stops the active turn. A manual editor change while an editor write is in progress still cancels the pending visual write.

After every successful source write, the assistant must call `strategy.testCurrentSource`. This reads the latest unsaved buffer, statically locates every `ctx` action call with its source line, and runs one `on_start` (when present) plus natural `on_bar` events through the same local JSONL Python protocol used by Profiles. The bounded fixtures contain 240 closed bars for every supported interval, use saved parameters, and cover an empty portfolio plus synthetic long and short position snapshots without forcing an entry or exit signal. A failure returns the Python or output-contract error for the assistant to repair; a statically checked call site may remain runtime-unreached. A pass only proves source policy and reached output paths completed and does not replace a historical backtest or prove every branch, fill, profitability, or live safety.

The research Skill receives saved parameters and platform-owned tuning ranges as strategy-version data. `strategy.saveVersion` validates and persists parameter changes as a new immutable snapshot; `strategy.backtest` pins an exact version and local data snapshot; `strategy.compareBacktests` and `strategy.getOptimizationResult` expose changes and train/validation evidence. It must explain and comment source in the current interface language and use the same current-time, market, portfolio, and action contract described above.
The legacy `npm run prepare:systematic-python` artifact path is reserved for a future bundled runtime. That artifact must provide `runtime-manifest.json` with schema `desic.systematic.python-runtime/v1`, target platform and architecture, a matching sandbox profile, every packaged file and SHA-256 digest, the Python executable path, and an explicit dependency inventory. Preparation must reject symbolic links, path traversal, target mismatches, missing dependency metadata, and checksum failures before copying only manifest-listed files into Tauri resources.

Staging that future artifact will improve runtime isolation; it does not by itself replace the Profile confirmation, account permission, risk, audit, idempotency, and reconciliation controls.
