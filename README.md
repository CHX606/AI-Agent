# Bit Agent

[![CI](https://github.com/CHX606/AI-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/CHX606/AI-Agent/actions/workflows/ci.yml)

基于 OpenAI Agents SDK 的桌面编程助手。读取代码、执行修改，并结合测试与检查结果继续处理，把“定位问题 → 修改 → 验证”串成可审阅、可审批的本地工作流。

> 持续开发中，主要在 Windows 上开发与验证。

## 核心能力

| 能力 | 实现 |
| --- | --- |
| Agent 执行循环 | OpenAI Agents SDK Runner 负责模型与工具循环；产品代码负责权限、持久化、上下文和完成判定 |
| 只读多 Agent | 关闭 / 开启 / 智能三种模式；子 Agent 只能列目录、读文件和搜索代码，每批 1–3 个，同一任务最多 3 个并发，累计批次不限，不可递归委派；主 Agent 汇总证据并统一修改 |
| 上下文管理 | 默认在历史达到可用输入预算的 75% 时，以降至 60% 为压缩目标；工具调用与结果成对保留，大型工具输出外置并记录 SHA-256 |
| 本地记忆 | 会话、工作记忆与长期经验保存于 SQLite；仅从通过独立验收的任务中提炼长期经验，新任务按关键词召回 |
| 权限与改动审阅 | 支持只读、逐次确认和允许修改模式；确认模式在补丁落盘前展示差异，删除文件与修改验证配置仍需明确批准；任务改动可审阅、撤销或提交 |
| OS 沙箱验证 | 测试、检查和独立验收命令由 Windows OS 沙箱执行；修改后的仓库验证在临时副本中运行，与修改前结果比较，只追究新增问题 |
| 独立验收 | 支持自动、总是和关闭；默认自动模式在改动达到 60 行或涉及至少 3 个代码文件时，派生测试 Agent 编写并运行验收用例，通过结论须引用当前版本的执行证据 |
| MCP 工具 | 接入 stdio / Streamable HTTP MCP Server，按权限模式和服务配置审批；支持在当前会话内批准同一服务的后续调用，敏感凭据使用系统加密存储 |
| 内置浏览器 | 通过本机 MCP 服务提供页面快照、截图和交互工具；只读操作无需审批，打开、点击和输入默认请求授权，支持会话内按服务批准；拒绝密码框输入，将页面内容标记为不可信数据 |
| 多模态与终端 | 支持图片附件与粘贴，通过 Responses / Chat Completions 原生图片块传递；桌面端内置 node-pty + xterm.js 终端 |

## 架构

```text
Electron Desktop / CLI
        │ HTTP + SSE（桌面端断线按游标续传）
        ▼
Fastify Gateway：请求校验、鉴权、事件推送
        │ stdin / stdout JSON Lines RPC
        ▼
Python AgentRuntime
  ├─ OpenAI Agents SDK Runner：主 Agent / 只读调查 Agent / 验收 Agent
  ├─ 工具层：文件、搜索、补丁、测试、检查、MCP
  ├─ Context Manager 与 Memory（SQLite）
  └─ Verification → Windows OS Sandbox
```

模型提出分析和工具调用，SDK 执行模型与工具循环；产品代码控制权限、保存状态和验证结果。Python 使用 import-linter、JavaScript / TypeScript 使用 dependency-cruiser 检查分层依赖方向。

## 关键设计

- **并发调查、统一修改**：只读调查 Agent 的工具列表不包含写入工具；主 Agent 核对证据后修改，避免多个调查任务同时写入同一文件。
- **客户端管理上下文**：按预算分段生成并校验摘要；默认模型摘要未完整生成或未通过结构校验时保留原历史，关键内容仍超过硬上限时明确停止。不依赖服务端保存 `previous_response_id`。
- **检查区分新增与已有问题**：失败时在私有副本中恢复本轮文件的修改前内容，比较 pytest 失败编号与 Ruff 规则计数；缺少可运行检查时标记“无法验证”。
- **默认本地运行**：Gateway 通过进程管道调用 Python，SQLite 保存会话与经验，无需 Redis、Docker 或独立数据库；模型调用和可选 MCP 仍依赖相应服务。
- **验证失败如实报告**：沙箱初始化失败不回退普通进程。Windows 默认向所有用户开放的目录需要完成 ACL 加固；沙箱仅覆盖受控验证命令，具体读写范围和系统授权见 [沙箱说明](docs/ENVIRONMENT.md)。

## 质量保障

- **CI**：GitHub Actions 在 Windows 运行 Ruff lint / format、Python 分层契约和 pytest，以及 Node 类型检查、测试与依赖边界检查。
- **历史回归记录**：2026-10-05 图片功能验收中，Python 697 项通过、6 项跳过；Desktop 353 项通过，Gateway 68 项通过、2 项跳过。数量对应当时版本，详见 [图片验收记录](docs/validation/IMAGE_INPUT_2026-10-05.md)。
- **沙箱安全回归**：2026-10-04 完成 ACL 加固后的本机记录中，真实 sandbox SDK 13 项通过，覆盖并发隔离、验证配置保护与工作区外写入限制，见 [沙箱修复记录](docs/validation/SANDBOX_FIXES_2026-10-04.md)。
- **便携版验收**：`scripts/accept-packaged.mjs` 启动真实 exe，检查流式回答、修改授权、图片输入、改动审阅、终端和浏览器；布局验收覆盖主题、窗口宽度、缩放与面板组合。

打包验收使用本地模拟模型，不能据此推断在线模型效果；sandbox-runtime 的 Windows 支持仍为 alpha。各次验收条件、结果和未覆盖范围见 [验收记录](docs/validation/)。

## 技术栈

Python 3.12 · OpenAI Agents SDK · MCP · Pydantic · SQLite · TypeScript · Electron · Fastify · Zod · xterm.js / node-pty · Vite / Vitest · uv / pnpm

## 文档

| 主题 | 文档 |
| --- | --- |
| 项目目录 | [目录指南](docs/PROJECT_STRUCTURE.md) |
| 架构与分层 | [架构说明](docs/ARCHITECTURE.md) |
| SDK 执行主线 | [运行主线](docs/SDK_RUNTIME.md) |
| 多 Agent | [多 Agent 说明](docs/MULTI_AGENT.md) |
| 上下文管理 | [上下文说明](docs/CONTEXT.md) |
| 本地记忆 | [记忆说明](docs/MEMORY.md) |
| 修改后的验证 | [验证规则](docs/VERIFICATION.md) |
| 沙箱与环境 | [沙箱说明](docs/ENVIRONMENT.md) |
| MCP 与浏览器 | [MCP 说明](docs/MCP.md) |
| 桌面与命令行 | [使用说明](docs/CLI_DESKTOP.md) |
| 完整导航 | [文档导航](docs/README.md) |

## 主要目录

```text
AI Agent/
|-- apps/
|   |-- desktop/       桌面窗口
|   `-- gateway/       接收任务的 HTTP 服务
|-- services/agent/    Python Agent、本地运行服务、工具、记忆和测试
|-- packages/diagnostics/ Gateway 与桌面共用的诊断日志
|-- docs/             项目文档
|-- evals/fixtures/    给 Agent 使用的示例题目
|-- infra/            记忆集成测试的配套服务配置
|-- workspaces/       实际操作的演示项目
|-- .test-runs/       某次运行的工作区副本和记录
|-- artifacts/        事件、上下文和评测产物
|-- node_modules/     安装好的 JavaScript/TypeScript 依赖
`-- .venv/            本项目的 Python 环境
```

隐藏缓存、每个子模块和根目录配置文件的解释见 [完整目录指南](docs/PROJECT_STRUCTURE.md)。

## 本地启动

以下命令在项目根目录的 PowerShell 中执行。需要 Python 3.12+、Node.js 24+、pnpm、Git、ripgrep；Windows 沙箱首次执行需要系统授权，说明见 [沙箱说明](docs/ENVIRONMENT.md)。项目 `package.json` 指定的包管理器是 `pnpm@11.19.0`，与当前使用版本一致。Node.js 和 Python 的具体版本分别写在根目录 `.node-version` 和 `.python-version`，CI 读取同样的文件。

### 0. 准备 Node、Python 和 uv（推荐 mise）

根目录的 `mise.toml` 让 [mise](https://mise.jdx.dev/) 读取上面两个版本文件、安装固定版本的 [uv](https://docs.astral.sh/uv/)，并在进入项目目录时自动激活 `.venv`。安装 mise 并在 PowerShell `$PROFILE` 中加入 `(&mise activate pwsh) | Out-String | Invoke-Expression` 后，在项目根目录执行：

```powershell
mise install
mise current
corepack enable pnpm
```

`mise install` 把指定版本下载到 mise 自己的目录，不改系统里已装的 Node/Python；`mise current` 应显示 node、python 和 uv 的版本；`corepack enable pnpm` 把 `pnpm` 命令放进 mise 管理的那份 Node 里。不使用 mise 时，自行准备这两个版本的 Node/Python 并安装 `mise.toml` 中写明版本的 uv。

### 1. 安装依赖

```powershell
uv sync --locked
pnpm install --frozen-lockfile
```

两边都按锁文件安装：`uv sync` 按 `uv.lock` 建立或更新 `.venv`，安装本项目和开发工具；`pnpm install` 按 `pnpm-lock.yaml` 安装 Gateway、Desktop 等 Node.js 依赖。`--locked` / `--frozen-lockfile` 表示锁文件与声明不一致时直接报错，而不是悄悄改版本。使用 PostgreSQL 长期记忆时改用 `uv sync --locked --extra memory`。

`uv sync` 会让 `.venv` 与锁文件完全一致，手动 `pip install` 的额外包会被移除。新增或升级 Python 依赖用 `uv add <包名>`（开发工具加 `--group dev`）或 `uv lock --upgrade-package <包名>`，并提交更新后的 `uv.lock`。

pnpm 的包仓库由 `pnpm-workspace.yaml` 的 `storeDir` 指定为项目目录旁边的 `D:\myproject\AI Agent.pnpm-store`，专供本项目使用；`pnpm store path` 应返回该目录下的 `v11`。同一配置中的 `allowBuilds.esbuild: true` 允许构建依赖 esbuild 执行安装脚本。

### 2. 配置模型

参考根目录的 `.env.example`，在自己的 `.env` 中填写聊天模型配置：

- `API_KEY`：访问模型服务使用的凭据。
- `BASE_URL`：模型服务地址。
- `MODEL_NAME`：模型名称。
- `MODEL_API`：接口类型。服务支持 `/v1/responses` 时用 `responses`（默认）；只提供 `/v1/chat/completions` 的兼容服务（多数国内服务商、Ollama 等本地推理服务）用 `chat_completions`。

便携版在界面“模型设置”中填写，点“测试连接”会用一次真实请求检查地址、密钥和模型，并自动选中可用的接口类型。

默认长期记忆使用本机 SQLite 和关键词检索，无需独立数据库或向量服务。PostgreSQL 与 Embedding 是可选部署方式，详见 [记忆说明](docs/MEMORY.md)。

### 3. 启动桌面与本地后台

```powershell
pnpm desktop:dev
```

这条命令先构建桌面，再启动 Gateway 和 Electron。Gateway 自动启动本地 Python 进程。
Gateway 默认是 `http://127.0.0.1:3000`。若已手动运行 Gateway，用 `pnpm desktop:only` 只打开界面。
关闭桌面会结束这一套开发启动进程，但会话记录仍在本机数据目录。`pnpm desktop:package` 生成包含 exe 的便携目录；需要保留整个目录，不是单文件安装器。

早期的 Redis 队列 + Python Worker 链路已删除；需要查看旧实现时，检出 git 标签 `legacy-redis`。

也可以使用命令行提交任务：

```powershell
./.venv/Scripts/bit-agent.exe run --workspace "D:/path/to/repository" --task "定位失败测试并修复"
```

这里的工作区是你要让 Agent 操作的项目。普通任务会在指定工作区上修改文件；评测脚本则会创建自己的隔离副本。

## 测试命令是什么意思

每次推送和 Pull Request 都会由 [CI](.github/workflows/ci.yml) 自动运行下表中的检查；本地也可以手动执行。

| 命令 | 检查内容 |
| --- | --- |
| `uv run pytest` | `services/agent/tests` 中的 Python 测试。 |
| `uv run ruff check services/agent`、`uv run ruff format --check services/agent` | Python 静态检查和格式。 |
| `pnpm test` | Node.js 工作区中各项目的测试。 |
| `pnpm typecheck` | Node.js 工作区的类型检查。 |
| `pnpm architecture:check` | JS 与 Python 的分层依赖规则。 |
| `pnpm desktop:package`，再 `node scripts/accept-packaged.mjs "<exe 路径>"` | 打包便携版并启动真实 exe 做端到端验收（使用本地假模型）。 |

默认跳过的真实集成测试：设置 `BIT_AGENT_TEST_LOCAL_RUNTIME=1` 运行 Gateway 与真实 Python 进程的串联测试；数据库测试和 Agent 做题评测需要额外服务，分别见 [基础设施说明](infra/README.md) 和 [评测目录说明](evals/README.md)。

## 为什么有些 README 还会提到“故障”或“未完成”

`evals/fixtures` 中有专门准备的题目，故意保留错误或空实现，供 Agent 展示修复能力。`.test-runs` 中的某次运行副本可能已经完成。同一道题的“原始题目”和“完成后的副本”可以同时存在。

例如工作流引擎原题仍有空实现，而已检查的那份运行副本有完整实现，历史记录显示当时 23 项测试通过。详见 [.test-runs 说明](.test-runs/README.md)。这个成绩不代表整个 Bit Agent 项目的测试都通过了。
