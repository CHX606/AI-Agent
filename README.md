# Bit Agent

Bit Agent 是一个帮你处理代码项目的 AI 助手。你告诉它“修复这个问题”，它会查看代码、调用模型分析、用工具修改文件，再根据测试和检查结果继续处理。

当前已经有桌面界面、命令行、本地 Python 执行服务、多 Agent 调查、记忆和上下文管理等实现，会话保存在本地 SQLite 中。它仍处于开发阶段，“模块已经写出来”不代表所有使用场景都没有 bug。

模型与工具之间的循环由 [OpenAI Agents SDK](docs/SDK_RUNTIME.md) 完成；`bit_agent.runtime` 管桌面任务和本地保存，工具模块管具体操作。

## 第一次看这个项目，先读哪里

1. [项目目录大白话指南](docs/PROJECT_STRUCTURE.md)：解释根目录、缓存、源码、测试和运行记录分别是什么。
2. [SDK 主线与学习入口](docs/SDK_RUNTIME.md) 和 [本地运行](docs/LOCAL_RUNTIME.md)：一次任务在代码里怎样执行和保存。
3. [桌面界面和命令行使用说明](docs/CLI_DESKTOP.md)：了解怎么启动、怎么提交任务。
4. [Python Agent 目录说明](services/agent/README.md)：了解真正执行任务的代码放在哪里。
5. [文档导航](docs/README.md)：按问题找到更深入的说明。

目录分层、接口连接和强制依赖规则见 [软件架构说明](docs/ARCHITECTURE.md)；执行 `pnpm architecture:check` 验证架构边界。

你前面看到的 `.npm-cache`、`.pnpm-store`、`.pytest_cache` 等目录，都在目录指南中单独解释。

## 当前做到了什么

| 部分 | 当前情况 | 用大白话解释 |
| --- | --- | --- |
| Desktop | 已有实现 | 用窗口选项目、发任务、看结果，也能浏览目录和预览文本文件。 |
| CLI | 已有实现 | 不开窗口，直接在终端提交和查询任务。 |
| Gateway + 本地运行库 | 已有实现，已通过本地验收 | Gateway 通过进程管道交给 Python，SQLite 保存任务和会话。 |
| 代码工具和 OS 沙箱 | 已有实现 | 能列目录、读文件、搜索、打补丁、运行测试和白名单检查。 |
| Multi-Agent | 三档模式已有实现，已通过本地验收 | 关闭、开启、智能；主 Agent 按模式调用只读调查工具，自己统一修改。 |
| Working Memory / 会话 | 本地持久化已有实现，已通过本地验收 | 保存历史、摘要和任务进度，没有 24 小时自动过期。 |
| 长期记忆 | 已接入桌面端，默认开启 | 独立验收通过的任务会提炼经验，存在本机 SQLite；新任务开始时按关键词召回本项目的相关经验，不需要数据库或向量服务；侧栏“长期记忆”可查看和删除。 |
| Context Manager | 已接入运行循环 | 历史太长时保存大段结果、压缩旧内容，控制发给模型的输入量。 |
| 修改后的验证 | 已有实现 | 失败时与修改前对比，只追究新问题；没法验证时如实显示“无法验证”；其他语言可在 `.bit-agent/verify.json` 配置命令。 |
| 模型接入 | 已有实现 | 支持 Responses 和 Chat Completions 两种接口，“测试连接”自动检测；可选更便宜的辅助模型。 |
| 项目说明与 Git | 已有实现 | 读取 `AGENTS.md`；审阅改动后只把本次任务的文件提交到 Git。 |
| 外部工具（MCP） | 已有实现 | 接入你配置的 MCP Server，调用前按服务确认。 |
| 用量与对话管理 | 已有实现 | 显示每个任务的 tokens 和估算费用；对话可搜索、重命名、删除；后台完成时系统通知。 |
| 评测和事件记录 | 已有实现 | 保存做题过程、修改内容和验证结果，方便回头查问题。 |
| 独立 Web 管理后台、生产级认证与配额 | 尚未提供完整方案 | 当前主要面向本地开发和验证。 |

“已通过本地验收”指用本地假模型实际启动 Gateway、Python 执行进程和桌面程序走通了对应流程；真实在线模型不在其范围内；OS 沙箱的独立验收另行记录。每次验收做了什么、没做什么，见 [docs/validation](docs/validation/)。

## 一次任务怎么流转

```text
你在 Desktop 或 CLI 输入任务
  -> Gateway 接收任务
  -> 本机 Python AgentRuntime 接收任务
  -> 按会话编号恢复历史与工作记忆
  -> OpenAI Agents SDK Runner 执行主 Agent
     -> 关闭：不提供子 Agent 工具
     -> 开启：要求优先分工，不强造无意义子任务
     -> 智能：模型自行决定是否调用只读子 Agent
  -> SQLite 保存记录，大型工具结果另存文件
  -> 结果与事件回到 Gateway
  -> Desktop 或 CLI 展示给你
```

模型负责分析和提出工具调用；SDK 负责反复请求模型并调用工具；产品代码负责权限、保存和修改后的验证要求。

普通对话是否需要工具由主 Agent 判断，不再单独跑一轮任务分类器。代码 Agent 修改代码后，当前框架要求测试通过，并且 Ruff lint 覆盖本轮修改文件。独立评测还有自己的验收步骤。具体规则见 [工具说明](docs/TOOLS.md)。

当前验收边界：已覆盖代码修改、Python 依赖环境准备、沙盒测试和质量检查；尚未接入浏览器自动化或 Computer Use。任务状态 `COMPLETED` 不代表网页交互、真实在线服务和音频播放均已验收，这些环节仍需单独验证。浏览器验收暂不作为当前实习项目的必做功能，后续可通过 MCP 或工具接口扩展。

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

如果需要长期记忆，再按 [记忆说明](docs/MEMORY.md) 配置独立的向量服务和数据库。Ollama 是一种向量服务配置选择，不是普通任务必须启动的组件。

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
