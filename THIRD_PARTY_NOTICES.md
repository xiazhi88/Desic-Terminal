# Third-Party Notices（第三方声明）

Desic Terminal 自身代码以 [MIT License](LICENSE) 开源。本项目使用并随安装包分发了以下第三方组件，版权归各自所有者，遵循各自许可证。本文件仅为主要组件概览；**完整许可证文本清单随安装包分发，并可在应用内"关于 → 开源许可"查看**。升级依赖时请同步检查本文件。

## 打包进安装包的运行时

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| Node.js 22.x | AI Sidecar 固定 Node 运行时 | MIT |
| CPython 3.13（python-build-standalone） | 系统化策略研究内置 Python 运行时 | PSF-2.0 |
| SQLite（经 rusqlite bundled 静态编译） | 历史/审计/复盘数据库 | Public Domain |
| numpy、pandas、scipy、scikit-learn、joblib、threadpoolctl | 策略研究 Python 环境（固定版本，运行时安装） | BSD-3-Clause |
| pytz、six | 同上 | MIT |
| tzdata | 同上 | Apache-2.0 |
| python-dateutil | 同上 | BSD-3-Clause 或 Apache-2.0 |

## 主要框架与库

| 组件 | 版权方 | 许可证 |
| --- | --- | --- |
| lightweight-charts（图表引擎） | TradingView, Inc. | Apache-2.0，保留 NOTICE 归属 |
| @cline/sdk、@cline/llms（AI Sidecar 核心运行时） | Cline Bot Inc. | Apache-2.0 |
| ai（Vercel AI SDK） | Vercel | Apache-2.0 |
| React / react-dom | Meta Platforms, Inc. | MIT |
| Tauri 2 及插件、tokio、serde、reqwest 等 Rust 依赖 | 各自作者 | MIT / Apache-2.0 双许可为主，完整解析见 Cargo.lock |
| GSAP / @gsap/react | GreenSock（Webflow） | 专有免费许可（非 OSI 开源），可免费商用、无署名要求 |
| 其余 npm 依赖（CodeMirror、three.js、zustand、i18next、lucide-react 等） | 各自作者 | MIT / ISC / Apache-2.0，完整清单见应用内许可页 |

## 商标与素材

- OpenAI、Anthropic、Google（Gemini）、xAI、DeepSeek、阿里云（Qwen）、Moonshot（Kimi）、火山方舟（Doubao）、MiniMax、智谱（GLM）的 Logo 为各公司商标，仅用于供应商识别展示。
- OKX 为 OKX 商标；本项目与 OKX 无隶属关系。
- Desic Terminal 名称与 Logo 归作者所有，MIT License 不授予商标使用权。
