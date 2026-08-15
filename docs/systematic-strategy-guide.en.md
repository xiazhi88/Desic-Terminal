# Systematic Strategy Guide

> English (current) · [简体中文](./systematic-strategy-guide.md)

> Write Python strategies → backtest on history → tune parameters → live Profiles: Desic Terminal's systematic research takes a strategy from idea to auditable automated execution — **without installing Python**.

---

## Contents

1. [Core Concepts](#1-core-concepts)
2. [Runtime Environment](#2-runtime-environment)
3. [Create a Strategy](#3-create-a-strategy)
4. [Strategy Programming Model](#4-strategy-programming-model)
5. [Historical Backtesting](#5-historical-backtesting)
6. [Replay and Review](#6-replay-and-review)
7. [Parameter Tuning](#7-parameter-tuning)
8. [Live Strategy Profiles](#8-live-strategy-profiles)
9. [Signal History](#9-signal-history)
10. [Best Practices](#10-best-practices)
11. [FAQ](#11-faq)

---

## 1. Core Concepts

| Concept | Meaning |
| --- | --- |
| **Strategy** | Python source + parameters, executed locally through a controlled protocol |
| **Version** | An immutable snapshot of strategy source and parameters; backtests and Profiles bind specific versions |
| **Backtest** | Simulates the strategy over historical candles under fill assumptions, producing an equity curve, fills and statistics |
| **Optimization** | Deterministic sampling across a parameter space, evaluated by Calmar on train/validation splits to find robust parameters |
| **Profile** | Binds a strategy version, contract, account and risk budgets into a live signal executor |
| **Signal** | The result of each 1-minute close evaluation: action, block reason or execution error |

The six workflow tabs:

```text
Strategy (write/version) → Backtest → Tuning → Review (result library) → Profiles (live) → Signals (history)
```

---

## 2. Runtime Environment

- **No Python install**: the installer ships a checksum-verified CPython runtime; opening Systematic Research for the first time prepares a local environment and installs a fixed dependency set (numpy, pandas, scikit-learn, …) automatically, with progress shown under the workspace header.
- The environment is **dependency isolation**: strategies can only import the allowlisted libraries and have no network, file-system or subprocess access.
- Failures get actionable guidance; development builds without the bundled runtime fall back to a system Python 3.12–3.13.

> [!NOTE]
> First-time dependency installation needs network access (mirrors are tried in order: Tsinghua → Aliyun → PyPI). After that everything runs locally.

---

## 3. Create a Strategy

**Strategy → New**, starting from one of four templates:

| Template | Fits |
| --- | --- |
| `blank.py` | Empty skeleton, write from scratch |
| `ema-trend.py` | Dual-EMA trend following |
| `macd-volume-atr.py` | MACD + volume + ATR protection |
| `bollinger-reversion.py` | Bollinger mean reversion |

**Editing experience**

- Built-in CodeMirror editor; every save creates a new version.
- **AI strategy assistant**: the right-hand panel supports multi-turn discussion of strategy ideas, lets the AI edit code and runs bounded tests in the controlled environment; its sessions are saved under the "AI strategies" category.
- Backtests, tuning and Profiles always reference a specific version — older results are never affected by new edits.

---

## 4. Strategy Programming Model

A strategy is a Python module implementing `on_bar`:

```python
def on_bar(ctx):
    # ctx: read-only context at the current decision point (after a confirmed 1m close)
    close = ctx.market_series("1m").close(-1)          # latest close
    ema_fast = ctx.indicator("ema", period=13).value(-1)
    ema_slow = ctx.indicator("ema", period=26).value(-1)

    fast = float(ctx.params.get("fastPeriod", "13"))
    slow = float(ctx.params.get("slowPeriod", "26"))

    if ema_fast > ema_slow and ctx.flat():
        return ctx.open_long(reason="fast crossed above slow")
    if ema_fast < ema_slow and ctx.position("long"):
        return ctx.close(reason="fast crossed below slow")
    return ctx.no_action(reason="waiting for a cross")
```

**Capabilities**

| Capability | Meaning |
| --- | --- |
| `ctx.market_series(interval)` | Candles of any built-in timeframe (1m – 1M), containing only bars confirmed up to the decision point |
| `ctx.indicator(...)` | Rolling built-in indicator computation, no full recomputation per bar |
| `ctx.params.get(key, default)` | Parameter access, strings or numbers |
| `ctx.flat()` / `ctx.position(side)` | Current position state |
| `ctx.open_long / open_short` | Open intents, optionally with protection parameters |
| `ctx.close` | Close intent |
| `ctx.no_action(reason)` | Explicit idle |

**Hard constraints**

- One action per bar; actions are intents — fills and sizing are decided by the host.
- No future data: a bar's close time must never exceed the decision point (double-checked by host and runtime).
- No imports outside the allowlist, no file/network/subprocess access.

See the [strategy protocol](./systematic-python-strategy-protocol.md) for the full specification.

---

## 5. Historical Backtesting

**Backtest → configure → Run backtest**

| Parameter | Meaning |
| --- | --- |
| Strategy & version | Pick the strategy and a concrete version |
| Contract | The backtest symbol (e.g. BTC-USDT-SWAP) |
| Initial equity / leverage | Starting account and leverage |
| Evaluation range | Formal evaluation start and end (up to one year) |
| Preload history | Context candles before evaluation start (indicator warm-up only — excluded from equity and statistics) |
| Fill assumptions | Entry/exit slippage and fees, margin safety multiplier |
| End-of-run policy | Mark to last close / force close |

Results land in the **Review** tab:

- Equity curve, max drawdown, win rate, profit factor and more
- Fill details and closed trades
- **Bar-by-bar replay**: drag the timeline to inspect equity, position, actions and signal reasons at any moment

> [!TIP]
> A backtest is a simulation: fill assumptions and bar-by-bar decisions differ from live matching. Use it to evaluate strategy logic, not as a promise of future returns.

---

## 6. Replay and Review

The replay view in Review is the key tool for debugging strategy behavior:

1. Drag the timeline to the target range (pages load on demand; timeouts prompt a retry).
2. Inspect the position, orders, equity and the strategy's action reason at that exact bar.
3. Cross-check the right-hand parameters and fills to understand *why* the strategy decided as it did.

> [!NOTE]
> Bar-level details of older backtests may be archived by storage maintenance (metrics and fills are kept); re-running the backtest restores the curve.

---

## 7. Parameter Tuning

**Tuning → configure the parameter space → Run tuning**

| Setting | Meaning |
| --- | --- |
| Candidate budget | 30 / 100 / 300 candidate parameter sets (deterministic sampling) |
| Parameter space | Min / max / step per parameter |
| Train/validation | The evaluation range splits 7:3 — search on train, confirm on validation |
| Metric | Validation Calmar (annualized return / max drawdown) |

After tuning finishes:

- The workbench shows candidates, train/validation metrics and estimated time remaining; cancel anytime.
- **Adopt best parameters**: writes the best set into the current draft and saves a new version in one click (run an independent backtest afterwards to confirm).
- Tuning only works on the draft — it never silently modifies a saved version.

> [!WARNING]
> Overfitting: validation results can still be "selected" by the parameter space. Run out-of-sample backtests before adopting, and prefer flat optima that are insensitive to parameter perturbation.

---

## 8. Live Strategy Profiles

A Profile turns a strategy version into a **live signal executor**:

**Bound at creation (fixed while enabled)**

- Strategy and exact version, contract
- Account and environment (demo / live)
- Cross/isolated margin, target leverage, direction permissions
- Per-entry margin budget and same-side total budget
- Daily realized-loss limit, entry cooldown
- Protections: TP/SL directions statically declared by the strategy source (market or trigger-after-limit)

**How it runs**

- Reuses the subscribed 1-minute candles: one `on_bar` evaluation per confirmed close.
- Before evaluating, the host waits for the just-closed candle to settle locally and re-verifies the confirmed cutoff; a failed repair skips the cycle with a real diagnostic — it never evaluates a partial window.
- The strategy only returns open/close intents; the host converts eligible opens into contract counts from fresh equity, the execution price, instrument value and lot-size rules, then routes through risk checks and idempotent submission.

**Activation requirements**

- The strategy version and contract have a **completed backtest**
- Local Python environment ready
- Account read and trade permissions
- Conflict review against enabled AI automation on the same account
- Explicit confirmation every time a live Profile is enabled

> [!WARNING]
> An enabled Profile places real orders. Validate contract conversion, margin, stops and notifications fully on demo before going live.

---

## 9. Signal History

The **Signals** tab shows every evaluation, filterable by Profile:

| Field | Meaning |
| --- | --- |
| Time | Confirmed close time of the 1-minute candle |
| Action | Open long/short, close intent, or idle |
| Block reason | The risk rule that blocked the action (budget, loss limit, cooldown, …) |
| Order | Order identifiers after submission |
| Error | This cycle's strategy, snapshot or execution error |

A single-cycle error does not stop the Profile immediately (normal risk rules still block the affected action); consecutive failures trigger an auto-stop safeguard. Strategy signals and blocked actions can be pushed to Feishu per notification settings.

---

## 10. Best Practices

1. **Backtest before live**: no version binds a Profile without a completed backtest.
2. **Few parameters first**: fix most parameters and tune only 2–3 key ones to avoid dimension explosion.
3. **Out-of-sample validation**: beware overfitting when validation results differ sharply from the search range.
4. **Protections live in the source**: TP/SL directions are statically declared by the strategy source — the host never invents a missing protection.
5. **Start small live**: begin with a minimal margin budget and a strict daily loss limit; scale after accumulating signal history.
6. **Read signal history regularly**: blocked actions and errors matter more than fills — they show whether risk controls work as intended.

---

## 11. FAQ

**Q: Do I need to install Python?**
No. The runtime ships inside the installer; Systematic Research prepares the environment on first open (network needed for dependencies).

**Q: Why do backtests differ from live?**
Backtests use confirmed 1-minute candles and fill assumptions (slippage, fees, mark policy); live matching, order queues and funding all differ.

**Q: Can a strategy hold long and short at once?**
No. The runtime keeps a single position state, and a strategy returns exactly one action per decision point.

**Q: Can tuning results go live directly?**
Recommended: adopt the best parameters as a new version → confirm with an independent backtest → then create a Profile from that version.

**Q: Does a Profile modify my strategy version?**
No. Profiles bind immutable version snapshots; editing the source creates a new version while enabled Profiles keep the old one.
