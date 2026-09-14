> 2026-09-09：Agent 执行主线已改用 OpenAI Agents SDK。先读 [SDK 主线与学习入口](docs/SDK_RUNTIME.md)；权限、交互和审阅见 [功能说明](docs/PRODUCT_HARDENING.md)。

# Bit Agent

Bit Agent 是一个帮你处理代码项目的 AI 助手。你告诉它“修复这个问题”，它会查看代码、调用模型分析、用工具修改文件，再根据测试和检查结果继续处理。

当前已经有桌面界面、命令行、本地 Python 执行服务、多 Agent 调查、记忆和上下文管理等实现。默认采用本地 SQLite 保存会话，不再要求 Redis。它仍处于开发阶段，“模块已经写出来”不代表所有使用场景都没有 bug。

文档对齐日期：2026-09-09。已补充本轮回归、类型检查、构建与真实 exe 验收。真实在线模型和 Docker 环境不包含在本机假模型验收结论中。

**刚接着学习本项目，先读 [SDK 主线与学习入口](docs/SDK_RUNTIME.md)，再读 [本地运行入口](docs/LOCAL_RUNTIME.md)。**
模型与工具之间的循环由 SDK 完成。`bit_agent.runtime` 管桌面任务和本地保存，工具模块管具体操作；旧 Redis 适配器不是默认桌面链路。

## 第一次看这个项目，先读哪里

1. [项目目录大白话指南](docs/PROJECT_STRUCTURE.md)：解释根目录、缓存、源码、测试和运行记录分别是什么。
2. [桌面界面和命令行使用说明](docs/CLI_DESKTOP.md)：了解怎么启动、怎么提交任务。
3. [Python Agent 目录说明](services/agent/README.md)：了解真正执行任务的代码放在哪里。
4. [文档导航](docs/README.md)：按问题找到更深入的说明。

目录分层、接口连接和强制依赖规则见 [软件架构说明](docs/ARCHITECTURE.md)；执行 `pnpm architecture:check` 验证架构边界。

你前面看到的 `.npm-cache`、`.pnpm-store`、`.pytest_cache` 等目录，都在目录指南中单独解释。

## 当前做到了什么

| 部分 | 当前情况 | 用大白话解释 |
| --- | --- | --- |
| Desktop | 已有实现 | 用窗口选项目、发任务、看结果，也能浏览目录和预览文本文件。 |
| CLI | 已有实现 | 不开窗口，直接在终端提交和查询任务。 |
| Gateway + 本地运行库 | 已接入源码，待验收 | Gateway 通过进程管道交给 Python，SQLite 保存任务和会话，不要求 Redis。 |
| 代码工具和 Docker 沙箱 | 已有实现 | 能列目录、读文件、搜索、打补丁、运行测试和白名单检查。 |
| Multi-Agent | 三档模式已接入源码，待验收 | 关闭、开启、智能；主 Agent 按模式调用只读调查工具，自己统一修改。 |
| Working Memory / 会话 | 本地持久化已接入源码，待验收 | 保存历史、摘要和任务进度，没有 24 小时自动过期。 |
| 长期记忆 | 已有实现，需要接入配置 | 用 PostgreSQL/pgvector 保存和检索经过审核的经验；普通 Worker 启动不会自动把这一整套启用。 |
| Context Manager | 已接入运行循环 | 历史太长时保存大段结果、压缩旧内容，控制发给模型的输入量。 |
| 评测和事件记录 | 已有实现 | 保存做题过程、修改内容和验证结果，方便回头查问题。 |
| 独立 Web 管理后台、生产级认证与配额 | 尚未提供完整方案 | 当前主要面向本地开发和验证。 |

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
|-- services/agent/    Python Agent、Worker、工具、记忆和测试
|-- packages/protocol/协议说明
|-- docs/             项目文档
|-- evals/fixtures/    给 Agent 使用的示例题目
|-- infra/            Docker 和配套服务配置
|-- workspaces/       实际操作的演示项目
|-- .test-runs/       某次运行的工作区副本和记录
|-- artifacts/        事件、上下文和评测产物
|-- node_modules/     安装好的 JavaScript/TypeScript 依赖
`-- .venv/            本项目的 Python 环境
```

隐藏缓存、每个子模块和根目录配置文件的解释见 [完整目录指南](docs/PROJECT_STRUCTURE.md)。

## 本地启动

以下命令在项目根目录的 PowerShell 中执行。需要 Python 3.12+、Node.js 24+、pnpm、Git、ripgrep 和可用的 Docker Engine。项目 `package.json` 指定的包管理器是 `pnpm@11.19.0`，与当前使用版本一致。

### 1. 安装依赖

```powershell
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -e ".[dev]"
pnpm install --frozen-lockfile
```

第一条建立 Python 环境；第二条安装本项目和开发依赖；第三条安装 Gateway、Desktop 等 Node.js 依赖。只有使用旧 Redis 或 PostgreSQL 适配器时才需要另外安装 `.[memory]`。

Node.js 依赖仓库由根目录 `pnpm-workspace.yaml` 的 `storeDir` 统一指定为 `D:\myproject\AI Agent.pnpm-store`（与项目目录同级、专供本项目使用）。pnpm 11 的这类项目配置写在该 YAML 文件中，不写入 `.npmrc`。在项目根目录或任一子包运行 `pnpm install`、`pnpm add`、`pnpm update` 都会使用该仓库；不要通过命令行或环境变量覆盖仓库路径。`--frozen-lockfile` 保持锁定的依赖版本和锁文件内容。

同一配置中的 `allowBuilds.esbuild: true` 允许现有构建依赖 esbuild 执行安装脚本，完成其二进制检查。

可在根目录运行以下命令核对仓库和构建：

```powershell
pnpm store path
pnpm --dir apps/gateway store path
pnpm --dir apps/desktop store path
pnpm -r build
```

前三条应统一返回 `D:\myproject\AI Agent.pnpm-store\v11`。该目录位于 Git 仓库之外；项目内遗留的 `.pnpm-store/` 也已被 `.gitignore` 忽略。本次保留旧的 `D:\.pnpm-store` 和项目内旧缓存。以后须先将其他项目逐一迁移、重新安装并验证构建，确认配置及依赖链接不再引用共享仓库，且没有安装任务运行，再清理 `D:\.pnpm-store`。

直接写 `./.venv/Scripts/python.exe -m pip`，表示明确使用这个项目里的 Python 去运行 pip，不依赖终端当前激活了哪个环境。

### 2. 配置模型

参考根目录的 `.env.example`，在自己的 `.env` 中填写聊天模型配置：

- `API_KEY`：访问模型服务使用的凭据。
- `BASE_URL`：模型服务地址。
- `MODEL_NAME`：模型名称。

如果需要长期记忆，再按 [记忆说明](docs/MEMORY.md) 配置独立的向量服务和数据库。Ollama 是一种向量服务配置选择，不是普通任务必须启动的组件。

### 3. 启动桌面与本地后台

```powershell
pnpm desktop:dev
```

这条命令先构建桌面，再启动 Gateway 和 Electron。Gateway 自动启动本地 Python 进程，不需要旧 Worker 和 Redis。
Gateway 默认是 `http://127.0.0.1:3000`。若已手动运行 Gateway，用 `pnpm desktop:only` 只打开界面。
关闭桌面会结束这一套开发启动进程，但会话记录仍在本机数据目录。`pnpm desktop:package` 生成包含 exe 的便携目录；需要保留整个目录，不是单文件安装器。

使用 `BIT_AGENT_RUNTIME=redis` 可显式选择旧模式，再自行启动 Redis 和旧 Worker；
新会话恢复和三档模式仅针对默认本地链路。不会自动迁移或删除旧 Redis 数据。

也可以使用命令行提交任务：

```powershell
./.venv/Scripts/bit-agent.exe run --workspace "D:/path/to/repository" --task "定位失败测试并修复"
```

这里的工作区是你要让 Agent 操作的项目。普通任务会在指定工作区上修改文件；评测脚本则会创建自己的隔离副本。

## 测试命令是什么意思

下面列出的是开发者可以手动执行的命令，不表示本轮更新文档时已经执行过。

| 命令 | 检查内容 |
| --- | --- |
| `./.venv/Scripts/python.exe -m pytest` | 默认检查 `services/agent/tests` 中的 Python 测试。 |
| `./.venv/Scripts/python.exe -m ruff check services/agent` | 检查 Python 代码的静态问题。 |
| `pnpm test` | 递归执行 Node.js 工作区中各项目定义的测试。 |
| `pnpm typecheck` | 递归执行 Node.js 工作区的类型检查。 |

真实数据库测试、Gateway/Worker 联调和 Agent 做题评测需要额外服务，分别见 [基础设施说明](infra/README.md) 和 [评测目录说明](evals/README.md)。

## 为什么有些 README 还会提到“故障”或“未完成”

`evals/fixtures` 中有专门准备的题目，故意保留错误或空实现，供 Agent 展示修复能力。`.test-runs` 中的某次运行副本可能已经完成。同一道题的“原始题目”和“完成后的副本”可以同时存在。

例如工作流引擎原题仍有空实现，而已检查的那份运行副本有完整实现，历史记录显示当时 23 项测试通过。详见 [.test-runs 说明](.test-runs/README.md)。这个成绩不代表整个 Bit Agent 项目的测试都通过了。
> 2026-09-09 验收更新：本地运行链路已通过回归和真实 Electron 串联检查。文中早先的“未验收”描述是修改阶段的记录；最新结果及未覆盖范围见 [本地版验收报告](docs/ACCEPTANCE_LOCAL_RUNTIME.md)。
