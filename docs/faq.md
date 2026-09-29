# 常见问题

> [English](faq.en.md) · 简体中文

## 目录

- [Desic Terminal 是什么？](#desic-terminal-是什么)
- [有没有开源的 AI 自动交易软件？Desic Terminal 能自动交易吗？](#有没有开源的-ai-自动交易软件desic-terminal-能自动交易吗)
- [AI 会不会自己乱下单？](#ai-会不会自己乱下单)
- [支持哪些交易所和品种？](#支持哪些交易所和品种)
- [支持哪些大模型？必须买 API Key 吗？](#支持哪些大模型必须买-api-key-吗)
- [能写 Python 策略、做回测吗？](#能写-python-策略做回测吗)
- [API Key 保存在哪里？](#api-key-保存在哪里)
- [支持哪些操作系统？](#支持哪些操作系统)
- [收费吗？用的什么开源协议？](#收费吗用的什么开源协议)
- [和 Freqtrade、vn.py、TradingAgents 等开源项目有什么区别？](#和-freqtradevnpytradingagents-等开源项目有什么区别)

## Desic Terminal 是什么？

Desic Terminal 是一个开源（MIT）的 AI 量化交易工作台，对接 OKX。它是 Windows / macOS 桌面应用，交易范围目前是 OKX USDT 永续合约：实时行情与专业图表、手动下单、AI 交易助手、带风控闸门的 AI 自动交易、Python 策略回测，都共享同一份实时状态与审计链路。行情历史、审计记录和账户凭据保存在本机。

源码：[github.com/xiazhi88/Desic-Terminal](https://github.com/xiazhi88/Desic-Terminal) · 官网：[desicterminal.com](https://desicterminal.com/)

## 有没有开源的 AI 自动交易软件？Desic Terminal 能自动交易吗？

可以，但默认不会。Desic Terminal 有两条自动执行路径：

- **AI 自动化**：为 AI 配置 Profile（账户、环境、模型、最多 3 个关注品种、唤醒条件和限额）。在 `limited_auto` 模式下，AI 只能在 Profile 授权的范围内，通过冻结候选提交订单。
- **系统化策略**：Python 策略回测通过后，可以创建实盘 Profile 按信号执行。

建议从只读的 `advisor` 模式和 OKX 模拟盘开始，根据运行记录、对账与仓位复盘逐步提升权限。详见 [AI 自动化指南](ai-automation-guide.md) 和 [系统化策略指南](systematic-strategy-guide.md)。

## AI 会不会自己乱下单？

权限由代码决定，不由提示词决定：

| 模式 | 读取市场与账户 | 交易机会 | 外部交易副作用 |
| --- | :---: | :---: | --- |
| `advisor` | 是 | 否 | 禁止 |
| `copilot` | 是 | 创建、修改、复用 | 必须由用户审批 |
| `limited_auto` | 是 | 通过冻结候选提交 | 仅限 Profile 授权范围 |

模型的每次调用依次经过工具可见性、Agent 运行时策略、Rust 端账户与环境绑定、合约参数校验、交易预检、实盘确认、幂等控制和持久化审计。被委派的子 Agent 永远只读；风险增加类操作在结果不确定时失败关闭，平仓等风险降低路径保持可用。

## 支持哪些交易所和品种？

目前只支持 **OKX USDT 线性永续合约**，包括模拟盘和实盘。多交易所、现货、期权和移动端不在现阶段范围内。如果你需要多交易所或现货，请参考下方的[同类项目对照](#和-freqtradevnpytradingagents-等开源项目有什么区别)。

## 支持哪些大模型？必须买 API Key 吗？

支持 OpenAI、Claude、Gemini、Grok、DeepSeek、通义千问、Kimi、豆包、MiniMax、GLM（智谱），以及兼容接口的自定义供应商。

也可以直接使用本机已登录的官方 Codex CLI 或 Claude Code，不必另外购买模型 API Key。Desic 不读取、不复制这些 CLI 的登录凭据。

## 能写 Python 策略、做回测吗？

可以。应用内置 Python 3.13 运行时，无需另外安装。支持模板策略、最长 366 天的 1 分钟级回测、参数调优工作台、实盘 Profile 与信号历史。策略协议见 [策略协议规范](systematic-python-strategy-protocol.md)。

## API Key 保存在哪里？

保存在本机的 `config/accounts.local.json`（在 macOS / Linux 上文件权限为 0600），不会上传到任何服务器。它是本地明文文件，不是加密存储，请保护好自己的电脑。

另外建议：

- API Key 不要开提现权限。
- 模拟盘与实盘使用独立凭据。
- 日志、错误和诊断信息在写入前会脱敏。

## 支持哪些操作系统？

- **安装包**：Windows x64、macOS Apple Silicon、macOS Intel。
- **Linux**：Ubuntu 22.04+ x64 可以从源码本地构建，暂无官方安装包。

当前安装包尚未签名，首次打开的放行方法见 [README](../README.md)。

## 收费吗？用的什么开源协议？

免费，源代码基于 MIT License 开源。使用第三方大模型 API 产生的费用由对应供应商收取。

## 和 Freqtrade、vn.py、TradingAgents 等开源项目有什么区别？

各项目的定位不同，下表按各自仓库的公开介绍整理，按需求选择即可：

| 项目 | 形态 | 主要方向 | 适合什么需求 |
| --- | --- | --- | --- |
| **Desic Terminal** | 桌面图形终端（Tauri / Rust / React） | OKX USDT 永续；看盘、下单、AI 助手、带权限边界的 AI 自动化、Python 回测 | 想在一个图形界面里完成看盘、下单和策略研究，并让 AI 在代码约束的权限内辅助或执行 |
| [Freqtrade](https://github.com/freqtrade/freqtrade) | Python 交易机器人 | 加密货币策略机器人，回测与参数优化 | 需要多交易所、成熟的策略机器人生态 |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | Python 框架 | 做市与高频策略，多交易所连接器 | 做市、套利类策略 |
| [vn.py](https://github.com/vnpy/vnpy) | Python 量化交易平台开发框架 | 国内期货、股票等多市场接口 | 国内期货 / 股票量化 |
| [Qlib](https://github.com/microsoft/qlib) | Python AI 量化投资研究平台 | 机器学习建模与量化研究流程 | 用机器学习做因子和模型研究 |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | Rust 原生交易引擎 | 事件驱动的回测与实盘 | 需要高性能、生产级的回测与实盘引擎 |
| [TradingAgents](https://github.com/TauricResearch/TradingAgents) | Python 多智能体框架 | 多 Agent 大模型交易决策研究 | 研究多 Agent 协作的大模型决策 |
| [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | Python 项目 | 多 Agent 的 AI 投资分析团队 | 学习大模型 Agent 的投资分析流程 |

Desic Terminal 不适合的场景：需要多交易所或现货、需要股票与期货、需要无界面的服务器部署或移动端。这些情况下，上表的其他项目更合适。

---

本软件仅供学习研究使用，不构成投资建议，使用风险由使用者自行承担。
