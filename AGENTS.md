# Desic Terminal Agent Instructions

本文件是所有 Agent 开始开发前必须阅读的项目入口规范，适用于整个仓库。

## 1. 开始任务前

- 先阅读 `PRODUCT.md`，理解产品定位和当前开发阶段。
- 阅读 `docs/development-guidelines.md`，遵守项目已有的架构、安全、交易和 UI 规范。
- 根据任务检查仓库内与当前模块直接相关的公开文档；本地规划与内部规格不作为协作前置依赖。
- 先检查 `git status -sb`，保留用户已有改动，不覆盖、不回退无关文件。
- 代码发现优先使用 codebase-memory MCP：`search_graph`、`trace_path`、`get_code_snippet`、`query_graph`、`get_architecture`。仅在查找文本、配置或图谱结果不足时使用 `rg`。

## 2. 开发原则

- 修改范围必须紧贴当前任务，不顺带进行无关重构。
- 优先复用现有模块、类型、组件和工具函数。
- 主 Tauri crate 只承担 command、事件、窗口、凭据、路径和外部 IO 编排；纯领域逻辑应放入对应 workspace crate。
- 不继续向 `src-tauri/src/lib.rs` 堆积可独立拆分的大函数。
- 交易、安全、签名、权限、数据库迁移和密钥存储属于高风险区域，修改时必须扩大验证范围。
- 不为了测试方便降低交易风控、工具权限或敏感信息保护。

## 3. 敏感信息与本地文件

- 禁止在源码、测试、日志、Markdown、截图和提交信息中写入真实 API Key、Secret、Passphrase、密码、Token 或私钥。
- 测试数据必须使用明显的占位值，不能使用外观接近真实凭据的固定字符串。
- 不提交 `config/*.local.json`、`.env*`、数据库、日志、缓存、构建产物、系统凭据或个人编辑器配置。
- 提交前检查 `.gitignore` 是否仍覆盖本地运行文件，并对待提交内容执行敏感信息扫描。

## 4. 最低验证要求

- 前端或 TypeScript 修改：

```powershell
npm run build
```

- Rust 修改：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml --workspace
```

- AI 工具权限修改：

```powershell
npm run test:ai-policy
```

- 账户、代理、AI 配置或凭据存储修改：

```powershell
npm run smoke:config-security
```

- 运行与改动直接相关的 smoke test。无法运行时，必须在交付说明中明确原因和剩余风险。

## 5. 文档维护

- 用户可见的产品能力发生实质变化时更新 `PRODUCT.md` 或 `README.md`。
- 新发现的通用规范或踩坑记录更新 `docs/development-guidelines.md`。
- 本地规划、完成项台账和内部规格保持为未跟踪文件，不作为 GitHub 文档的一部分。
- 不为了微小实现细节制造无意义的文档变更。

## 6. Git 工作流

- 每个提交只包含一个可解释、可回退的逻辑单元。
- 不使用 `git add -A` 暗中混入无关用户改动；工作区混合时显式暂存相关文件。
- 小型低风险修改可以在 `main` 完成；较大功能、架构调整和高风险交易逻辑使用 `feature/*`、`fix/*` 或 `refactor/*` 分支。
- Agent 不得因为完成代码修改而自动提交或推送。
- 只有用户明确要求 commit、push、发布或创建 PR 时，才执行相应 Git/GitHub 操作。
- 推送前必须确认分支、提交范围、验证结果和远端目标；公开仓库推送前再次确认没有敏感信息和本地文件。

## 7. 交付要求

- 说明实际修改内容、验证命令及结果。
- 明确指出未完成项、未运行测试和残余风险。
- 不声称未实际验证的功能已经通过。
