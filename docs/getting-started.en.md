# Desic Terminal — Getting Started

> English (current) · [简体中文](./getting-started.md)

> From installation to your first trade, then the AI assistant and systematic research — this guide walks through the core workflows of Desic Terminal.

---

## Contents

1. [What is Desic Terminal](#1-what-is-desic-terminal)
2. [Installation](#2-installation)
3. [First Launch](#3-first-launch)
4. [Configure an OKX Account](#4-configure-an-okx-account)
5. [Get to Know the Trading Workspace](#5-get-to-know-the-trading-workspace)
6. [Place Your First Trade](#6-place-your-first-trade)
7. [Configure the AI Assistant](#7-configure-the-ai-assistant)
8. [Analyze the Market with AI](#8-analyze-the-market-with-ai)
9. [Custom Chart Indicators](#9-custom-chart-indicators)
10. [Market Intelligence](#10-market-intelligence)
11. [Next Steps](#11-next-steps)

---

## 1. What is Desic Terminal

Desic Terminal is an **AI-native trading terminal for OKX USDT perpetual contracts** that unifies six workspaces in one real-time context:

| Workspace | What you can do |
| --- | --- |
| **Trading** | Market, order book, depth, candles, order entry, position management |
| **Pro Charts** | Multi-timeframe multi-pane charts, 20+ built-in indicators, layers, drawings and quick trading |
| **AI Assistant** | Read market/account/intelligence evidence in conversation, produce opportunities and chart actions |
| **AI Automation** | Background AI Profiles that wake on conditions, with audit and position reviews |
| **Systematic Strategy** | Python strategy backtesting, parameter tuning and live Profiles (no Python install) |
| **Market Intelligence** | Time-series evidence: news, sentiment, flows, Smart Money and system stress |

> [!TIP]
> Validate everything on the **OKX demo environment** first. Demo and live use separate credentials, while every order, notification and risk-control path behaves identically.

> [!WARNING]
> Desic Terminal does not provide investment advice. Perpetual contracts, leverage and automation can cause rapid and significant losses.

---

## 2. Installation

Download the build for your platform from [GitHub Releases](https://github.com/xiazhi88/Desic-Terminal/releases):

| Platform | Package |
| --- | --- |
| Windows x64 | `Desic-Terminal_Windows-x64-setup.exe` |
| macOS Apple Silicon (M1+) | `Desic-Terminal_macOS-arm64.dmg` |
| macOS Intel | `Desic-Terminal_macOS-x64.dmg` |

> [!IMPORTANT]
> Current packages are unsigned. On macOS, drag the app into Applications and right-click → Open on first launch; Windows SmartScreen prompts require verifying the download source.

**Requirements**

- Windows 10+ or macOS 12+
- Network access to OKX and your chosen AI provider
- **No Python install needed** — the systematic research runtime ships inside the installer

---

## 3. First Launch

1. The main window opens in the **trading workspace**: title bar and watchlist on top, candles in the middle, order book and ticket on the right.
2. The left rail switches workspaces: Trading, Opportunities, AI Automation, Systematic Research, Intelligence, Data.
3. The notification center in the top-right collects in-app notifications; you can forward them to a Feishu bot in Settings.

> [!NOTE]
> Database initialization and background recovery run in dedicated tasks at startup. Opening "Systematic Research" for the first time prepares the built-in Python environment automatically (progress shows on a thin bar under the workspace header); backtests and Profiles work as soon as it finishes.

---

## 4. Configure an OKX Account

**Settings → Account → Add account**:

1. Create an **API key** on OKX with trading-related permissions only.
2. Fill in Key / Secret / Passphrase and choose the environment (`demo` or `live`).
3. After saving, the desktop app opens a dedicated Private WebSocket and syncs historical fills and orders.

| Recommendation | Why |
| --- | --- |
| Start with demo | Validate contract sizes, margin modes, stops and notifications first |
| No withdrawal permission | API keys must not include withdrawal rights |
| Separate credentials | Demo and live each get their own keys |

> [!WARNING]
> Any live operation executed by AI or automation requires explicit confirmation. Make sure you understand each account's permission scope.

---

## 5. Get to Know the Trading Workspace

Every panel in the trading workspace shares one symbol and account context:

- **Watchlist**: switch symbols on the left, drag to reorder.
- **Order book / Depth**: live levels and depth chart on the right.
- **Recent trades**: latest trade tape.
- **Ticket**: limit, market, algo orders; attach TP/SL or OCO.
- **Positions & orders**: manage, amend, cancel and close in the tabs below.

All quantities are submitted in OKX **contracts (lots)**, with coin amount, notional value, estimated margin, fees and stop risk shown alongside — so contracts, coins and USDT exposure are never confused.

**Chart essentials**

| Action | How |
| --- | --- |
| Change timeframe | Chart toolbar (1m – 1M) |
| Add an indicator | Indicator button → pick and configure; multiple instances supported |
| Toggle layers | Layers button → indicators / price lines / drawings / analysis / fills / measure |
| Detached windows | Chart windows button → 1/2/3/4-pane layouts, each pane with its own symbol and timeframe |
| Quick trading | Right-click the chart or drag price lines to form trade intents directly |

---

## 6. Place Your First Trade

Example: a **demo limit order**.

1. Pick the demo account in the top account switcher.
2. In the ticket choose `Limit`, a direction (long/short), price and size; attach TP/SL if needed.
3. The preview dialog shows contract count, estimated margin and fees — verify, then submit.
4. The order appears under "Orders"; once filled it moves to "Positions" and the chart shows the **position line, entry price line and TP/SL lines** (all draggable).
5. Close from the positions row, or drag the chart position line to a target price for a quick close.

> [!NOTE]
> Every trade passes quantity normalization, Rust risk prechecks, idempotent reservation and audit. If the network times out after submission, the desktop reconciles with OKX using a stable execution key instead of blind retries.

---

## 7. Configure the AI Assistant

**Settings → AI** to configure a model service:

1. Pick a provider: OpenAI, Anthropic, Gemini, Grok, DeepSeek, Qwen, KIMI, Doubao, MiniMax, Zhipu, or any compatible API.
2. Fill in the API key and model name, save and run a connectivity test.
3. Optionally configure a locally installed official **Codex CLI** or **Claude Code** channel — requests still obey the terminal's tool permissions.

> [!TIP]
> Providers differ in capability, context length and cost. Start with a cost-effective model and switch per session when needed.

---

## 8. Analyze the Market with AI

Open the **AI trading assistant** on the right:

1. Ask, for example:

   ```text
   Read the live price, order book, 1-hour candles, funding rate and open interest
   of BTC-USDT-SWAP and give a concise analysis with data timestamps.
   ```

2. The assistant reads live market, account, orders, history, news and Smart Money evidence through **allowlisted tools**, streaming reasoning, tool calls and timing.
3. Tool results carry **data time, source and freshness**, so the model distinguishes facts, inference and data gaps.

**Permission modes** (chosen per session/configuration):

| Mode | Read market & account | Trade opportunities | External trade side effects |
| --- | :---: | :---: | --- |
| `advisor` | Yes | No | Forbidden |
| `copilot` | Yes | Create/edit/reuse | User approval required |
| `limited_auto` | Yes | Frozen-candidate submission | Profile-authorized scope only |

> [!IMPORTANT]
> Permissions are a hard boundary, not a prompt. A model cannot raise its own privileges through output text.

---

## 9. Custom Chart Indicators

The indicator center ships MA, EMA, VWAP, Bollinger, Supertrend, Ichimoku, MACD, RSI, KDJ, ATR, ADX, Stochastic, CCI, ROC, Williams %R, MFI, OBV and more.

Custom indicators use a **safe JSON DSL** (no JavaScript execution, no file or network access):

1. Indicator center → New custom indicator.
2. Write expressions in the CodeMirror editor, or use the **indicator AI assistant** to discuss ideas — DSL is only generated when you explicitly ask to create or update.
3. After saving, the indicator passes schema validation and versioning and enters the library for any chart.

---

## 10. Market Intelligence

The intelligence panel is a set of **time-series evidence shared by manual workflows and AI tools**:

- **News & events**: list, full text, clustering, importance and multi-window market reactions
- **Sentiment**: coin sentiment snapshots, trends, heat and long/short rankings
- **Economic calendar**: weekly/monthly views, region, importance, previous/forecast/actual
- **Flow structure**: price + OI combinations, taker flows, retail vs elite positioning
- **Smart Money**: trader performance, positions, historical orders, aggregate signals and divergence
- **Derivatives state**: funding, basis, liquidation samples, insurance fund, price limits and ADL

Every view discloses data time and coverage; missing or stale data is flagged explicitly — no old snapshots disguised as current state.

---

## 11. Next Steps

- Want AI to watch the market and review trades in the background → [AI Automation Guide](./ai-automation-guide.en.md)
- Want to backtest, tune and run Python strategies → [Systematic Strategy Guide](./systematic-strategy-guide.en.md)
- Want implementation details and safety boundaries → [PRODUCT.md](../PRODUCT.md) and the [strategy protocol](./systematic-python-strategy-protocol.md)

> [!TIP]
> A suggested path: manual demo trading → `advisor` AI conversations → `copilot` approved opportunities → systematic backtests → a small automation Profile. Each step builds on what the previous step validated.
