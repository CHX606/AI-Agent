# 软件分层与目录约定

更新：2026-09-11。目录已经实际迁移，规则由 `pnpm architecture:check` 检查。

采用模块化分层：顶层按可独立启动的应用/服务划分，应用内部再按职责分层。数据层归入 `infrastructure/persistence` 或 Python Runtime 的 `infrastructure`；业务只通过端口接口访问它。`agent`、`context`、`memory`、`tools` 等现有功能模块继续按功能组织，避免把一个功能拆散到整个仓库。

## 当前主运行链路目录

```text
apps/desktop/src/
  main/
    main.ts                         装配入口
    application/                    任务输入与端口接口
    transport/                      Electron 窗口、IPC、preload
    infrastructure/
      gateway/                      HTTP 客户端适配器
      persistence/                  文件预览、主题和执行设置
      runtime/                      子进程及系统密钥保存
      observability/                桌面日志与诊断导出
  renderer/                         展示与界面交互
  shared/                           两个进程共享的数据约定

apps/gateway/src/
  index.ts                          启动、选择本地或 Redis 后端
  bootstrap.ts                      默认适配器装配
  domain/                           任务状态、数据约定与校验
  application/ports/                TaskStore 接口
  transport/http/                   Fastify 路由与 SSE
  infrastructure/
    runtime/                        Python 子进程 RPC 客户端
    persistence/                    Redis、内存存储适配器
    observability/                  Gateway 日志

services/agent/src/bit_agent/runtime/
  __main__.py                       进程启动、锁和 RPC 方法装配
  bootstrap.py                      默认 SQLite/文件/验证适配器装配
  domain/                           产品错误、工具约定
  application/                      会话、任务、审批、暂停、分工与端口
  infrastructure/                   SQLite、改动文件记录、项目验证
  transport/                        JSON-lines RPC

packages/diagnostics/               共用日志接口及实现
scripts/                           开发、打包与验收入口
docs/                              说明与验收记录
```

## 接口怎样连接

| 调用方 | 依赖的接口 | 在装配入口选择的实现 |
| --- | --- | --- |
| 桌面 IPC | DesktopServices、GatewayClientPort、RepositoryPort、RuntimePort、PreferencesPort | GatewayClient、本地文件适配器、受管子进程 |
| HTTP 路由 | TaskStore、DiagnosticService | LocalTaskStore 或 RedisTaskStore；测试使用 MemoryTaskStore |
| Python AgentRuntime / TaskInteraction | StoragePort、WorkingMemoryStore | LocalStorage、SQLiteWorkingMemoryStore |
| Python 任务/工具编排 | JournalFactory、ChangeJournalPort、ProjectVerifier | ChangeJournal、verify_project |
| Python RPC | 异步方法表 | 启动入口绑定 AgentRuntime 方法 |

接口只描述允许调用的方法和数据类型，具体 SQL、文件操作、网络请求留在适配器中。接口不意味着删除实现；装配入口需要把实现注入调用方。没有引入额外的 DI 容器或第二套任务执行框架。

## 强制依赖规则

- 业务层不得导入本模块的基础设施、通信层或装配入口。
- 通信层通过接口访问业务/存储，不创建 SQLite、Redis 或子进程适配器。
- 适配器可以实现业务端口，不得反向调用任务编排或 HTTP/IPC。
- Gateway 领域约定、桌面 shared 数据约定保持独立；renderer 不得引用主进程实现。
- JavaScript 检查循环依赖。Python 检查上述规则时也检查间接引用。

规则使用成熟工具 [dependency-cruiser](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md) 和 [Import Linter](https://import-linter.readthedocs.io/en/stable/contract_types/forbidden/)，配置分别位于根目录 `.dependency-cruiser.cjs` 和 `pyproject.toml`。`pnpm lint` 已包含架构检查。

```powershell
pnpm architecture:check
pnpm -r typecheck
pnpm -r test
.venv\Scripts\python.exe -m pytest -q
pnpm desktop:package
```

Python 检查优先使用项目 `.venv`，也可以设置 `BIT_AGENT_PYTHON`。开发环境需安装 `pip install -e ".[dev]"`。根目录 TypeScript 6 供 dependency-cruiser 解析；桌面和 Gateway 继续使用各自的 TypeScript 7 编译器。

## 保留的行为与数据

`python -m bit_agent.runtime`、桌面启动与打包命令保持可用。默认 Python 服务通过 `runtime/bootstrap.py` 的 `create_runtime()` 创建；直接构造 AgentRuntime 时应注入存储、工作记忆、改动记录工厂和验证接口。

任务执行循环、审批、暂停、取消、SQLite 结构与上下文恢复规则没有借目录迁移改写。用户数据、依赖目录、历史发布包及工作区已有修改均保留。此次迁移前源码副本与文件移动表在 `tmp/architecture-before/`，该目录只用于本次开发回溯，不作为新的业务存储。
