# FAQ

> English · [简体中文](faq.md)

## Contents

- [What is Desic Terminal?](#what-is-desic-terminal)
- [Is there an open-source AI trading app that can trade automatically?](#is-there-an-open-source-ai-trading-app-that-can-trade-automatically)
- [Can the AI place orders on its own?](#can-the-ai-place-orders-on-its-own)
- [Which exchanges and markets are supported?](#which-exchanges-and-markets-are-supported)
- [Which AI models are supported? Do I need an API key?](#which-ai-models-are-supported-do-i-need-an-api-key)
- [Can I write Python strategies and backtest them?](#can-i-write-python-strategies-and-backtest-them)
- [Where are my exchange API keys stored?](#where-are-my-exchange-api-keys-stored)
- [Which operating systems are supported?](#which-operating-systems-are-supported)
- [Is it free? What is the license?](#is-it-free-what-is-the-license)
- [How does it compare with Freqtrade, Hummingbot, NautilusTrader or TradingAgents?](#how-does-it-compare-with-freqtrade-hummingbot-nautilustrader-or-tradingagents)

## What is Desic Terminal?

Desic Terminal is an open-source (MIT), AI-native quant trading workstation for OKX crypto markets. It is a desktop app for Windows and macOS; trading currently covers OKX USDT perpetual swaps. Realtime charts, manual order entry, an AI trading assistant, AI trading automation behind code-enforced risk gates, and Python strategy backtesting share one live state and audit trail. Market history, audit records and account credentials stay on your machine.

Source: [github.com/xiazhi88/Desic-Terminal](https://github.com/xiazhi88/Desic-Terminal) · Website: [desicterminal.com](https://desicterminal.com/)

## Is there an open-source AI trading app that can trade automatically?

Desic Terminal can, but it does not by default. There are two automated execution paths:

- **AI automation.** You configure a Profile: account, environment, model, up to three watched symbols, wake conditions and limits. In `limited_auto` mode the AI can submit orders only inside the scope the Profile authorizes, through frozen candidates.
- **Systematic strategies.** Once a Python strategy has been backtested, a live Profile can execute its signals.

Start with the read-only `advisor` mode on an OKX demo account. Raise permissions step by step, based on run history, reconciliation and position reviews. See the [AI Automation guide](ai-automation-guide.en.md) and the [Systematic Strategy guide](systematic-strategy-guide.en.md).

## Can the AI place orders on its own?

Permissions are enforced in code, not in prompts:

| Mode | Read market & account | Trade opportunities | External trading side effects |
| --- | :---: | :---: | --- |
| `advisor` | Yes | No | Forbidden |
| `copilot` | Yes | Create, amend, reuse | Requires user approval |
| `limited_auto` | Yes | Submitted via frozen candidates | Only within the Profile's authorization |

Every model tool call passes through several checks in order:

1. Tool visibility
2. Agent runtime policy
3. Rust-side account and environment binding
4. Contract parameter validation
5. Trade precheck
6. Live confirmation
7. Idempotency control
8. Durable audit

Delegated sub-agents are always read-only. Risk-increasing actions fail closed when the outcome is uncertain, while risk-reducing paths such as closing a position stay available.

## Which exchanges and markets are supported?

Only **OKX USDT linear perpetual swaps**, on both demo and live accounts. Multiple exchanges, spot, options and mobile are out of scope for now. If you need those, see the [comparison below](#how-does-it-compare-with-freqtrade-hummingbot-nautilustrader-or-tradingagents).

## Which AI models are supported? Do I need an API key?

Supported providers:

- OpenAI, Claude, Gemini, Grok
- DeepSeek, Qwen, Kimi, Doubao, MiniMax, GLM (Zhipu)
- Any compatible custom endpoint

You can also delegate to the official Codex CLI or Claude Code already signed in on your machine, so buying a model API key first is not required. Desic does not read or copy those CLIs' credentials.

## Can I write Python strategies and backtest them?

Yes. A Python 3.13 runtime ships with the app, so there is nothing to install. You get:

- Strategy templates
- Backtests on up to 366 days of 1-minute data
- A parameter-tuning workbench
- Live Profiles with signal history

See the [Strategy Protocol](systematic-python-strategy-protocol.md).

## Where are my exchange API keys stored?

Locally, in `config/accounts.local.json`. On macOS and Linux the file mode is 0600. Keys are never uploaded to any server.

It is a plaintext local file, not encrypted storage, so keep your machine secure. Also:

- Never grant withdrawal permission to the API key.
- Keep separate credentials for demo and live.
- Logs, errors and diagnostics are redacted before they are written.

## Which operating systems are supported?

- **Installers:** Windows x64, macOS Apple Silicon and macOS Intel.
- **Linux:** Ubuntu 22.04+ x64 can be built from source. There is no official Linux installer yet.

The installers are not code-signed yet. See the [README](../README.en.md) for how to open them the first time.

## Is it free? What is the license?

It is free, and the source code is released under the MIT License. Any third-party model API usage is billed by that provider.

## How does it compare with Freqtrade, Hummingbot, NautilusTrader or TradingAgents?

These projects target different needs. The table below is based on each repository's own description:

| Project | Form | Focus | Choose it when you need |
| --- | --- | --- | --- |
| **Desic Terminal** | Desktop GUI terminal (Tauri / Rust / React) | OKX USDT perpetuals: charting, order entry, AI assistant, permission-bounded AI automation, Python backtesting | One graphical workspace for charting, trading and strategy research, with AI assisting or executing inside code-enforced limits |
| [Freqtrade](https://github.com/freqtrade/freqtrade) | Python trading bot | Crypto strategy bot with backtesting and optimization | Multiple exchanges and a mature strategy-bot ecosystem |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | Python framework | Market making and high-frequency strategies, many exchange connectors | Market making and arbitrage |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | Rust-native trading engine | Event-driven backtesting and live trading | A high-performance, production-grade engine |
| [Qlib](https://github.com/microsoft/qlib) | Python AI quant research platform | Machine-learning modeling and quant research workflow | ML-driven factor and model research |
| [vn.py](https://github.com/vnpy/vnpy) | Python quant platform framework | Chinese futures, equities and other market gateways | Quant trading on Chinese futures and equities |
| [TradingAgents](https://github.com/TauricResearch/TradingAgents) | Python multi-agent framework | Multi-agent LLM trading-decision research | Research into collaborating LLM agents |
| [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | Python project | A team of AI agents for investment analysis | Learning how LLM agents analyze investments |

Desic Terminal is not the right fit if you need several exchanges, spot, equities or futures, headless server deployment, or mobile. In those cases the other projects above suit you better.

---

This software is for learning and research only. It is not investment advice, and you use it at your own risk.
