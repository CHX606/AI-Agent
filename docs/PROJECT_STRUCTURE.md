# 项目目录大白话指南

这份指南用于回答“这个文件夹里到底放了什么、它帮项目做了什么”。源码目录于 2026-09-11 按分层架构更新；缓存和历史运行示例保留原有说明。自动生成的版本号、随机编号和文件数量以后可能变化。

**当前分层结构、接口依赖与检查命令见 [软件架构说明](ARCHITECTURE.md)。** Desktop 主进程、Gateway、Python Runtime 都已区分 `application`、`infrastructure`、`transport`，由装配入口连接具体实现。

## 先认清几种东西

| 类别 | 大白话解释 | 常见位置 |
| --- | --- | --- |
| 我们写的源码 | 项目的实际功能实现。 | `apps`、`services` |
| 文档与配置 | 说明怎么使用，以及告诉工具按什么规则运行。 | `docs`、根目录配置、`infra` |
| 安装好的依赖 | 别人写好的代码，我们的项目会使用它。 | `node_modules`、`.venv` |
| 下载或检查缓存 | 帮工具少下载、少做重复检查的中间数据。 | `.npm-cache`、`.pnpm-store`、`.pytest_cache` 等 |
| 测试题和测试规则 | 用来验证项目、验证 Agent 能力的材料。 | `tests`、`evals/fixtures` |
| 运行工作区和产物 | 某次任务实际修改过的代码、结果和日志。 | `workspaces`、`.test-runs`、`artifacts` |

文件夹名字以点开头，不等于它一定是缓存。`.git` 保存版本历史，`.test-runs` 可能保存做完的代码，都需要按实际内容理解。

## 整体结构

```text
AI Agent/
|-- apps/
|   |-- desktop/
|   |   |-- src/main/          桌面程序主进程
|   |   |-- src/renderer/      界面
|   |   |-- src/shared/        两边共用的数据约定
|   |   |-- renderer/          HTML 入口
|   |   `-- test/             桌面模块测试
|   `-- gateway/
|       |-- src/              HTTP 接口、任务存储、事件转发
|       `-- test/             Gateway 测试
|-- services/agent/
|   |-- src/bit_agent/         Python 功能源码
|   |-- tests/                测试 Bit Agent 自己
|   `-- evals/                让 Agent 做题的评测入口
|-- packages/protocol/        Gateway 和 Worker 的通信说明
|-- docs/                     项目文档
|-- evals/fixtures/           独立示例题目
|-- infra/
|   |-- docker/               Docker Desktop 辅助启动脚本
|   |-- runtime/              开发和联调用 Redis 配置
|   |-- memory/               记忆后端测试服务配置
|   `-- sandbox/python/      Python 测试沙箱镜像配方
|-- workspaces/               实际演示工作区
|-- .test-runs/               运行副本和相应记录
|-- artifacts/
|   |-- context/              单独保存的大段模型上下文材料
|   |-- events/               执行事件
|   `-- evals/               独立评测产物
|-- tmp/                      测试、导出等临时工作目录
|-- .venv/                    本项目 Python 环境
|-- node_modules/             Node.js 项目已安装依赖
|-- .npm-cache/               npm 下载缓存和日志
|-- .pnpm-store/              迁移前遗留的 pnpm 包缓存
|-- .electron-cache/          Electron 下载缓存
|-- .pytest_cache/            pytest 的跨次运行缓存
|-- .ruff_cache/              Ruff 检查缓存
|-- .vscode/                  编辑器设置
`-- .git/                    Git 版本历史和内部数据
```

这里只展开与理解项目有关的层级。依赖、缓存和运行记录里的大量文件没有逐项罗列。

## 哪些内容提交到仓库

- 提交源码、自动化测试、评测原题、项目配置、依赖锁文件和维护文档。
- `release/` 只保存本机生成的便携版，不能连同内置 Python、Node 依赖一起提交。
- `.test-runs/` 只提交目录说明；其中的任务副本和现场记录留在本机。
- `.venv/`、`node_modules/`、构建输出、缓存、`tmp/` 和 `.pytest-tmp/` 不提交。
- `.env`、日志、上下文产物和实际工作区不提交，也不能仅因被 Git 忽略就认为可以删除。
- 有保留价值的验收结论归档到 `docs/validation/`，与可重新生成的临时测试文件分开。

上面的缓存目录是结构示例，清理后可能不存在；运行相应工具时可以重新生成。

## apps：能启动起来的应用

### apps/desktop

这是你看到的桌面窗口，使用 Electron。Electron 提供桌面窗口和本机能力，界面部分使用 HTML、CSS 和 TypeScript。

`src/main` 管窗口、选目录、受控读取本地文件和访问 Gateway；`src/renderer` 管按钮、任务记录、目录树和文本展示；`src/shared` 规定两边传递的数据格式。

`dist` 如果存在，是构建出来的运行文件；`test` 是开发测试。想改界面应从源码入手，不要直接改构建结果。详见 [Desktop 目录说明](../apps/desktop/README.md)。

### apps/gateway

它是客户端和后台之间的 HTTP 接口服务。它接收任务、查询任务、处理取消请求，并把执行事件发送给客户端。

`src/transport/http/app.ts` 定义接口，`src/index.ts` 和 `src/bootstrap.ts` 负责启动与装配。`src/application/ports` 定义操作接口，`src/infrastructure` 放本地 RPC、Redis、内存和日志适配器，`src/domain/protocol.ts` 定义数据约定。

这里不会自己完成代码分析和补丁修改，默认由本地 Python AgentRuntime 执行；Worker 是可选 Redis 链路。详见 [Gateway 目录说明](../apps/gateway/README.md)。

## services/agent：实际干活的 Python 代码

### src/bit_agent 下面的目录

| 目录或文件 | 用大白话解释 |
| --- | --- |
| `agent` | 单个 Agent 的运行循环：问模型、运行工具、处理结果、决定能否结束。 |
| `runtime` | 本地服务，内部按业务、领域约定、数据适配器和 RPC 分层。 |
| `worker` | 从 Redis 领任务，控制超时和取消，再把结果写回去。 |
| `multi_agent` | 拆分调查任务、并发安排子 Agent、汇总结果。 |
| `tools` | 读文件、搜索、补丁、测试、静态检查等实际工具。 |
| `tool_provider` | 把工具接到 Agent 上，可用本地调用或 MCP，也可限制工具权限。 |
| `llm` | 读取模型服务配置，定义提供给模型的工具接口。 |
| `context` | 查找相关代码，组织输入材料，压缩过长历史。 |
| `memory` | 保存任务进度、审核长期经验、对接存储和向量检索。 |
| `mcp_server` | 把同一套工具用 MCP 协议开放出来。 |
| `sandbox` | 在 Docker 中执行受限测试和检查。 |
| `security` | 检查文件路径是否越过工作区边界。 |
| `observability` | 记录执行过程中发生的事件。 |
| `evals` | 独立评测器，比较文件变动并执行验收。 |
| `models` | 仓库地图和代码索引等数据结构。 |
| `client` | Python 访问 Gateway 的客户端。 |
| `cli.py` | `bit-agent` 终端命令的入口。 |
| `__init__.py` | Python 包的入口或对外导出，不一定包含主要逻辑。 |

### tests 和 evals 为什么都有

`services/agent/tests` 测试我们写的 Agent 程序。例如路径检查是否正确、工具结果是否符合格式。

`services/agent/evals` 则让 Agent 处理一道具体题目，看它是否真的把问题修好。该目录的脚本会使用 `fixtures` 中的原题；真正的评测器实现位于 `src/bit_agent/evals`。

详见 [Python Agent 目录说明](../services/agent/README.md)。

## packages：共享约定

当前 `packages/protocol` 主要保存协议说明。它写明 Gateway 和 Worker 怎样存取 Redis 任务、如何命名状态。

目录名叫 packages，并不意味着其中每个目录都已经是可安装的软件包。当前协议的 TypeScript 和 Python 模型仍分别在各自源码中维护。

## docs：我们维护的说明书

包含产品范围、任务状态、工具、记忆、多 Agent、运行记录和启动说明。你可以直接阅读，也可以有意识地修改它们。

修改一份说明不会让程序自动具有新功能；内容应该跟实际代码保持一致。完整导航见 [docs/README.md](README.md)。

## evals/fixtures：给 Agent 的题目

| 目录 | 当前用途和情况 |
| --- | --- |
| `calculator_bug` | 简单计算器故障示例，原题仍保留错误。 |
| `agent_loop_a_plus_b` | 很小的加法示例，目前已是相加实现，用于理解工具循环。 |
| `workflow_engine_build` | 工作流引擎原题，故意保留待实现函数。 |

原题仍有错误或空实现，是为了重新评测。完成过一次后，应该保留做题副本的结果，不要把原题本身都改成答案。

## workspaces：实际拿来操作的示例项目

目前有 `desktop-demo-calculator`，供 Desktop 选择和操作。它的加法代码当前已经修好，README 已改为说明当前状态。

这里可以包含手工改过或 Agent 改过的代码。它不是下载缓存，不会因为你重新安装依赖就自动恢复内容。

## .test-runs：某次运行的现场

这里可能保留题目副本、修改后的代码，以及这次运行的结果。不同脚本可以使用不同结构。

你之前查看的工作流例子是：

```text
.test-runs/
`-- workflow-engine-f07cd13585f643ef924e61d78e2c6d98/
    |-- workspace/
    |   |-- workflow_engine/   这次运行实际处理过的源码
    |   |-- tests/             这道题的验收测试
    |   `-- README.md          工作区说明和原题要求
    `-- artifacts/
        |-- events.sse         实时事件保存下来的文本
        |-- gateway-result.json 最终回执和工具记录
        `-- tests-before.json  运行前记录的测试文件路径及哈希
```

`tests-before.json` 是文件指纹清单，不是“之前有多少测试失败”的成绩单。它可以作为比较测试文件是否被改动的基线。

该工作流副本已有实现，2026-09-03 的记录显示 23 项测试通过。这个数字只属于当时那次运行，不代表本次已经重新验证，也不代表 Bit Agent 所有测试都通过。

删除整个运行目录，会一起丢掉副本代码和历史记录。即便能重跑，也不保证得到完全相同的过程和结果。详见 [.test-runs 说明](../.test-runs/README.md)。

## artifacts：程序留下来的产物

`context` 保存太长的工具结果等上下文材料；`events` 保存事件日志；`evals` 保存评测结果和差异等证据。

这些通常由程序生成，但可能是排查 bug 的唯一现场。删除前应先确认是否还需要追溯对应任务。它们与 npm 的可重新下载缓存用途不同。

## infra：帮项目准备运行环境

`runtime` 提供正常开发或联调用 Redis 配置；`memory` 提供记忆后端测试环境；`sandbox/python` 定义运行目标 Python 测试的容器环境；`docker` 放 Windows 辅助启动脚本。

Dockerfile 像“环境配方”；镜像是按配方准备好的环境；容器是实际启动起来的一次运行。Dockerfile 文件本身不是一个正在运行的服务。

目录中的 Compose 配置只会启动文件里声明的服务，不会因为放在本项目里就自动启动全部组件。详见 [infra 说明](../infra/README.md)。

## .npm-cache：npm 留下的下载缓存

你当前看到的主要内容是：

| 内容 | 作用 |
| --- | --- |
| `_cacache/content-v2` | 按内容组织保存的缓存数据。 |
| `_cacache/index-v5` | 把请求或缓存键关联到对应内容及信息，方便查找。 |
| `_cacache/tmp` | 写入缓存过程中的临时位置。 |
| `_logs` | npm 操作日志，安装失败时可能有错误信息。 |
| `_update-notifier-last-checked` | 更新提示机制记录上次检查时间等状态的文件。 |

内容指纹解决“数据是不是一样”的问题；索引解决“根据请求，我应该去取哪一份数据”的问题，所以二者都有作用。

这是工具生成的数据，不是我们开发 Bit Agent 的主要源码。正常学习项目不需要逐个打开散列文件。

## .pnpm-store：pnpm 保存包内容的地方

当前项目及所有子包统一使用同级目录 `D:\myproject\AI Agent.pnpm-store`，由根目录 `pnpm-workspace.yaml` 的 `storeDir` 指定；实际存储路径为其下的 `v11`。它位于本项目 Git 仓库之外。

项目内旧 `.pnpm-store` 已于 2026-09-14 清理；同级目录中的当前依赖仓库和已安装的 `node_modules` 保持不变。旧目录曾包含 `v10` 和 `v11` 两个布局，下面保留结构说明，方便理解：

| 位置 | 用途 |
| --- | --- |
| `v10/files`、`v11/files` | 保存按内容组织的包文件。 |
| `v10/index` | 该布局下的索引。 |
| `v11/index.db` | 当前这个布局中的索引数据库文件。 |

`v10`、`v11` 是 store 布局版本标识，不能只看名字就判断现在终端运行的是哪个 pnpm 版本。两个目录同时存在，也不代表每次安装都会同时使用它们。

`00`、`a0` 等短目录名用于按哈希前缀分散文件。有些目录为空，并不等于出错。

没有后缀的内容文件可能是 JavaScript、JSON、声明文件，也可能是二进制数据。后缀不是文件内容本身；给二进制文件加 `.js` 不会把它变成代码。不要为了阅读而改 store 文件名，实际使用时的文件名由包安装结构还原。

`.pnpm-store` 负责储存和复用包内容，`node_modules` 提供项目使用依赖时的安装结构，两者不是简单重复的文件夹。

## .electron-cache：Electron 下载缓存

Electron 是让网页技术能做成桌面窗口的运行环境。安装 Desktop 依赖时，相关安装工具会下载 Electron 运行文件。

这里的长编号目录和带 `electron-v...` 名称的文件属于下载缓存。它不是我们的桌面界面源码，也不是应该手工修改的 Electron 版本配置。项目需要的版本由 Desktop 的依赖声明和锁文件决定。

## .pytest_cache：pytest 记住上次运行的信息

| 文件 | 作用 |
| --- | --- |
| `v/cache/nodeids` | pytest 缓存的测试标识列表，帮助后续运行。 |
| `v/cache/lastfailed` | 缓存哪些测试上次失败，供只重跑失败项等功能使用。 |
| `.gitignore` | 避免把缓存内容作为普通源码提交。 |
| `CACHEDIR.TAG` | 表明这是缓存目录，供支持该约定的工具识别。 |
| `README.md` | pytest 生成的缓存说明。 |

真正的测试代码在 `tests` 目录。`nodeids` 和 `lastfailed` 是运行缓存，不是整套测试源码，也不是所有历史测试的永久档案。

通常可以在没有相关测试运行时清理这个缓存。下一次启用缓存的 pytest 运行会重新生成需要的数据，但“上次失败了谁”的旧信息不会凭空恢复。

## .ruff_cache：Ruff 的检查缓存

Ruff 用它减少重复检查。你看到的 `0.16.3` 是相关版本的缓存目录，里面的数据由 Ruff 管理；`.gitignore` 和 `CACHEDIR.TAG` 分别说明忽略规则和缓存身份。

真正的检查规则在根目录 `pyproject.toml` 的 Ruff 配置中，不在这个缓存目录里。清理缓存不会替你修复代码问题，只会让后续检查重新计算相应结果。

## .venv 和 node_modules：安装好的环境与依赖

`.venv` 是这个项目的 Python 虚拟环境。Windows 下的 `Scripts` 存 Python 和命令入口，`Lib/site-packages` 存安装的 Python 包。

`node_modules` 存 Node.js 项目安装的依赖和关联入口。pnpm 会按它的规则组织内部目录和链接，不宜靠手工移动其中的文件管理依赖。

这两者不是业务源码。删除后需要重新安装；手工改依赖内容也容易在重装时丢失。开发自己的功能时，应优先修改 `apps` 和 `services`。

## tmp、__pycache__、编辑器和版本目录

| 内容 | 作用 |
| --- | --- |
| `tmp/pytest-...` | 开发测试使用过的临时工作目录。 |
| `tmp/pdfs` | 当前存在的 PDF 相关临时目录；仅凭名字不能保证里面都是可以丢弃的文件。 |
| `__pycache__/*.pyc` | Python 为加快后续导入生成的字节码缓存。 |
| `.vscode/settings.json` | VS Code 的项目级编辑器设置。 |
| `.git` | 版本历史、分支和索引等 Git 内部数据；不是普通缓存。 |

临时目录在任务结束后可能可以清理，但要先看它是否存着唯一一份输出。目录叫 tmp，也不能证明所有内容都可以随意丢弃。

## 根目录文件是什么

| 文件 | 用途 |
| --- | --- |
| `README.md` | 项目首页和入口说明。 |
| `pyproject.toml` | Python 项目信息、依赖、命令入口、pytest 和 Ruff 配置。 |
| `package.json` | Node.js 项目信息、包管理器版本和常用脚本。 |
| `pnpm-workspace.yaml` | 定义工作区子包、统一的依赖仓库路径和允许执行安装脚本的依赖。 |
| `pnpm-lock.yaml` | 记录 Node.js 依赖解析结果，让安装更一致。 |
| `.env.example` | 本地配置的示例模板。 |
| `.env` | 这台机器实际使用的配置，可能包括模型凭据。 |
| `.gitignore` | 告诉 Git 哪些文件通常不作为源码跟踪。 |
| `.gitattributes` | Git 处理文本、换行等内容时使用的规则。 |

这些配置不是解释性文字。随意改动依赖名、脚本、缩进或变量名，可能影响安装和运行。

## 学习时优先看哪里

想理解窗口，读 Desktop；想理解接口，读 Gateway；想理解 AI 怎样工作，读 Python 的 `agent`、`tools` 和 `multi_agent`；想知道为什么失败，读 `tests` 和对应运行记录。

下载缓存和第三方依赖中的 Markdown 由工具或依赖维护，不纳入本项目说明的逐份改写。这份指南解释它们的用途，避免下次安装覆盖掉手工写在缓存里的说明。
