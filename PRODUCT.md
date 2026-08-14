# Product

## Product Name

Desic Terminal

## Register

product

## Users

Active crypto derivatives traders and analysts who use a desktop terminal for continuous market monitoring, chart analysis, order management, and AI-assisted research or execution.

## Product Purpose

Provide a fast, dependable OKX perpetual trading workspace where realtime market data, durable news and smart-money intelligence, local historical data, charting, account operations, and an AI trading assistant work as one coherent desktop tool.

Market Intelligence news is stored locally as durable article and event evidence. The news workspace supports local-day navigation, bounded pagination, and per-device read cursors; background refreshes count only articles first seen after the cursor, so repeated synchronization does not create false unread alerts.

## Current Systematic Research Boundary

Systematic Research is a local, single-contract strategy research workspace for eligible USDT perpetuals. Its scheduler invokes Python `on_bar` only after a confirmed 1-minute K-line, while strategy code can read current-time-bounded `1m`, `3m`, `5m`, `15m`, `30m`, `1H`, `2H`, `4H`, `6H`, `12H`, and `1D` series. A higher-timeframe final bar may be explicitly marked incomplete and contains only information available at that minute. New strategy creation requires an explicit template choice: a minimal no-trade blank entrypoint or a bundled research starter; the create action no longer silently inserts trading logic. Users can version Python packages with immutable saved `ctx.params`, current virtual-account state, open orders, fills, closed trades, and funding records. A save creates a new immutable version only when the name, description, source, parameters, or desktop-owned tuning ranges changed. The version history supports paged inspection and comparison, can load a historical snapshot only into the current unsaved draft, and can start a new backtest or Profile from an exact historical version. A package returns one high-level market or limit opening/closing action, an order cancellation, a no-action, or a position-protection action; it cannot access credentials, query arbitrary data, or submit an exchange order. Desktop-owned numeric parameter ranges are editable only in the desktop tuning workbench, are fixed when a run starts, and cannot be declared by source code.

### Parameter tuning workbench

Parameter tuning uses a dedicated workbench instead of exposing the optimization action beside raw JSON. The workbench recommends signal parameters, keeps protection and sizing parameters opt-in, validates the current value against each range, and offers fixed Fast/Standard/Deep budgets of 30, 100, or 300 candidate groups. Starting a run saves the current draft as an immutable research version, pins that version to the run, uses the fixed 70/30 train-validation split, and samples oversized grids deterministically so the same version and ranges reproduce the same candidate set. The optimizer reuses loaded K-line and contract data, keeps one Python process per CPU-aware worker lane, and reports progress, elapsed/estimated remaining time, and cancellation state. Completed results include the baseline validation Calmar, sampling mode, candidate budget, and the saved strategy version; adopting a result immediately creates the next strategy version and opens its backtest settings.

Backtests pin the Python strategy version, local K-line snapshot, virtual initial equity, preloaded confirmed history before the formal evaluation start, leverage (1x-50x), safety-margin multiplier, conservative fees/slippage, and end-of-run policy. Formal evaluation defaults to the latest 30 days ending at least one hour before the current time, and supports a maximum 366-day one-minute range; preload remains visible to the first decision but never enters equity, replay, PnL, drawdown, or statistics. Market actions fill at the next minute open. Limit actions enter a pending-order state at that open and then use only later 1-minute OHLCV traversal plus a volume-participation cap, so their results are explicitly a conservative K-line estimate rather than an order-book-queue simulation. Pending limits can partially fill, remain open, be cancelled, or expire. A full simulated close clears protection only after it fully fills; a partial close retains it. When remaining virtual margin or the configured entry budget cannot reach the contract minimum, the backtest records an opening `no_action` with the sizing reason and continues instead of failing the whole run. The virtual-margin exhaustion rule is deliberately conservative and is not an exchange liquidation-price estimate. Results preserve a complete local ledger and candle-by-candle replay with fill labels, point-in-time virtual balance and margin, current/historical positions, reproducible statistics, total elapsed time, and persisted phase diagnostics. Long replays initially load a bounded recent candle page; moving the replay timeline loads the page containing the selected time while preserving the account and ledger state. Backtest records expose the exact pinned strategy version. The stateful backtest contract rejects look-ahead data and implicit position reversals. Transparent K-line factors remain research evidence, not trained-model validation or trade commands.

In Strategy Research, the desktop app ships a bundled, checksum-verified CPython 3.11 runtime inside its resources and creates one Desic-owned local virtual environment from it when needed; development builds without a staged bundle fall back to a compatible Python 3.10-3.13 interpreter on PATH. That environment installs only the fixed scientific dependency set used by the source-policy allowlist and runs a strategy through the current-time JSONL contract. Python receives no account credentials, proxy configuration, arbitrary data API, or order function. The local venv is dependency isolation rather than an operating-system security sandbox, so Profiles must be activated only for source the user has reviewed and trusts.

An enabled Strategy Profile pins an exact Python version, account, environment, contract, cross/isolated margin mode, target leverage, direction permissions, per-entry margin budget, same-side total margin budget, daily realized-loss limit, cooldown, and notification preference. It reuses the existing confirmed 1-minute K-line stream and fresh private-account snapshot; it does not create a second market subscription. Before evaluation, the host waits briefly for the just-closed candle to settle in local storage, repairs the complete visible history plus the recent tail when necessary, and verifies the exact confirmed cutoff again. A failed repair skips that cycle and records the real synchronization diagnostic; it never evaluates against a partial window and retries on later confirmed closes. The Python process returns only a validated open/close intent with a reason; the desktop converts eligible opens into exchange-valid contract counts from the Profile budget, instrument contract value, minimum size, lot size, equity, leverage, and existing same-side usage. It then applies Profile risk checks and sends eligible market or limit orders through the existing audited, idempotent WSS-first order route. Before entries, the host checks and, if required, synchronizes actual OKX leverage to the Profile target. Entry-attached TP/SL is supported. Profile settings expose market or trigger-after-limit execution for protection sides statically declared by the pinned strategy source; take-profit also supports a post-fill resting limit submitted immediately after actual entry fills and resized as partial fills arrive. The host never invents a missing stop-loss or take-profit. An accepted close request is only recorded as submitted; Desic does not manually cancel attached TP/SL on that acknowledgement, and OKX cancels exchange-managed attached TP/SL once the position is fully flat. Before a Profile strategy close is submitted, the host cancels that Profile's post-fill resting TP orders and marks them superseded so reconciliation cannot recreate them. Dynamic protection amendment remains disabled for live Profiles until reconciliation is complete. When an OKX account is saved or tested, the desktop verifies its position mode and automatically switches `net_mode` to `long_short_mode` when the API key can write account settings. If OKX refuses the switch because positions or orders remain, the notification center explains how to flatten and retry, and activation stays blocked. Live activation requires an exact completed backtest, local Python availability, account read/trade permission, hedge mode, conflict review against active AI automation, and an explicit confirmation. Profiles cannot be edited while running. Signal history preserves actions, blocks, order identifiers, and errors; a per-cycle runtime, snapshot, or execution error is recorded for review instead of immediately stopping the Profile. Optional Feishu delivery also obeys the global strategy-signal event setting.

The three interactive AI assistants use one open Cline Agent runtime. Their conversations remain scope-bound and persisted locally, while open-agent mode (enabled by default) also exposes Cline's native file, shell, browser, network, MCP, and user Skill capabilities. Users can choose workspace roots and use their own Skills or MCP servers. External files, web pages, and media are research input and cannot change Desic's system role or trading controls. Strategy edits remain versioned and tested, indicators remain safe DSL documents, and account or market operations remain structured Desic tool calls. Direct order submission, Profile activation, credential access, and exchange reconciliation stay behind the existing Desic authorization and audit chain; opening the Agent runtime does not inject API secrets into Cline.

The AI strategy assistant remains bound to the currently selected Python strategy editor and may read, test, and update only that unsaved editor buffer through revision-checked tools. The AI trading assistant uses a separate session-scoped strategy research workspace: it may create strategies, save immutable versions, backtest, compare, and optimize strategies created in that same conversation, but it cannot read or modify an existing strategy editor or activate a Strategy Profile. Research results can be opened in Strategy Research without replacing the current editor draft.

Strategy Profile runtime, market-data, account-snapshot, and host position-sizing failures are tracked consecutively. After three consecutive runtime failures, the affected Profile is disabled and the notification center records the automatic stop. Ordinary risk blocks such as cooldown, direction permission, or daily loss limits are audited but do not count as runtime failures.

## Brand Personality

Precise, calm, professional. The interface should feel focused under sustained use and communicate risk, state, and execution outcomes without decorative noise.

## Anti-references

Avoid marketing-page composition, oversized headings, decorative cards, excessive rounding, bright ornamental gradients, and interactions that cover critical trading data without a clear reason.

## Design Principles

- Keep realtime trading information scannable and stable during rapid updates.
- Make state, permission, risk, and execution consequences explicit.
- Preserve workspace context while revealing secondary tools progressively.
- Treat news, macro events, sentiment, and smart-money activity as attributable evidence, never as an implicit trade command.
- Prefer familiar desktop-terminal interactions over novel controls.
- Keep dense workflows efficient without making the interface visually loud.

## Accessibility & Inclusion

Maintain readable contrast, keyboard-operable controls, non-color status cues, and reduced-motion fallbacks for every transition.
The system interface follows the operating-system language by default and supports explicit language selection, while preserving Prompt, Skill, AI-generated, user-authored, and third-party original content verbatim.
