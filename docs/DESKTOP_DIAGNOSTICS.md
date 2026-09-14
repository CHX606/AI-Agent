# 桌面日志、诊断与分层边界

更新：2026-09-11。

## 客户操作

侧栏「日志与诊断」可以查看任务当前正在等待模型、工具、审批/确认、用户回答、执行资源，或者已经暂停。点击「导出脱敏诊断包」，选择保存位置，即可得到 ZIP。空会话也可导出；运行服务不可用时仍可导出已经写入的日志。程序启动失败的提示框也提供导出入口。没有自动上传。

界面错误显示简明中文和 `D-…` 诊断编号。客户反馈时提供编号、发生时间和主动导出的 ZIP 即可。

## 日志位置与容量

- 打包桌面默认：Electron `userData/runtime/logs`，通常是 `%APPDATA%/bit-agent/runtime/logs`。以诊断界面显示的绝对路径为准。
- 设置 `BIT_AGENT_DATA_DIR` 时，默认使用该目录下的 `logs`。
- `BIT_AGENT_LOG_DIR` 可独立指定三进程共享的日志根目录，由桌面入口传给子进程。
- 开发模式独立启动 Gateway/Python 时，默认使用 `%LOCALAPPDATA%/BitAgent/runtime/logs`；如需三进程放在同一位置，应统一设置上述环境变量。

根目录下面分别是 `electron/`、`gateway/`、`python/`。当前日志为 `current.jsonl`，每行一个 JSON。Node 的旧文件以时间戳命名，Python 的旧文件是 `.1` 到 `.3`。

每进程约 4 MiB 轮转，最多保留当前文件和 3 个备份，即约 16 MiB；三进程合计约 48 MiB。保留期限为 7 天，启动、轮转或后续写入时清理过期文件。关闭应用期间不会有后台清理。Node 还有每日轮转。完整单条记录、轮转瞬间及极少量同步致命错误记录可能带来小幅容量超出；轮转管理文件不计入正文预算。

日志与业务数据的保留策略独立，清理日志不删除会话、SQLite、transcript、context_state、working_memory 或用户文件。用户自行导出的 ZIP 不自动清理。

## 已覆盖的诊断

| 场景 | 记录内容 |
| --- | --- |
| 模型请求 | HTTP 状态、服务商错误码、安全分类说明、服务商 request ID、尝试次数、耗时；主模型及同步上下文摘要客户端都有 HTTP 观测 |
| 网络/流式异常 | 网络/超时类别、异常类型、流式中断、未收到完成事件就结束、请求总耗时 |
| 启动/进程退出 | 启动与就绪、退出码、signal、是否正常关闭、Python RPC 中断、未处理异常、Electron 渲染进程及子进程异常 |
| 三进程通信 | HTTP/RPC/SSE 失败、关联请求号、耗时与超时、SSE 自动重连次数；创建任务等写操作不会因日志功能新增重试 |
| 慢任务 | 根据现有 events 和任务状态推导阶段；每 60 秒只读观察仍在等待的任务，不改变执行状态 |
| 工具失败 | 复用已有 TOOL_COMPLETED 和工具记录，补充诊断号；日志只记录工具调用号、错误码及耗时 |
| 保存与恢复 | SQLite 操作名、异常类型与错误码、文件保存失败、恢复失败及意外中断任务的诊断编号 |

日志统一包含 UTC 时间、级别、进程、PID、软件版本，以及可获取的 session_id、task_id、tool_call_id。没有关联业务对象的启动日志使用 null，不伪造编号。模型调用另有 run_id、agent_id、request_id；Gateway 到 Python 使用 rpc_id 连接两边的记录。

暂停、主动取消、拒绝审批不一律记为 ERROR。等待用户的观察记录是 INFO，慢模型/工具/资源等待是 WARN。Python 日志使用标准 logging/RotatingFileHandler；Node 使用 Pino、rotating-file-stream；Gateway 保留 Fastify 的日志接口。Electron 使用自身的进程生命周期和异常事件，不启用上传崩溃转储。

## 隐私和故障隔离

诊断采用字段白名单，再对已知密钥、Bearer、常见 key/token 形式、URL、路径和邮箱进行脱敏。HTTP 请求/响应正文、认证头、完整提示词、文件内容、环境变量、模型配置文件、原始异常消息和堆栈首行不进入诊断日志。异常只保留类型、错误码和受限的代码位置。子进程任意 stderr 不原样保存，只提取错误类型和字节数。

兼容模型服务可能在错误说明里回显用户输入，因此只保存服务商错误码及安全分类说明；未知服务商的任意原文说明不保存。业务会话记录本身仍按原来的规则保存，诊断包不复制这些原始内容。

ZIP 仅包含经过再次投影/脱敏的日志、manifest.json 和 runtime.json。runtime.json 来自已有 SQLite 事件与任务的元数据，默认最多最近 50 个任务、每任务 200 个非文本增量事件；导出还将事件列表限制在 1000 条。选择任务时优先导出该任务的元数据。数据库、完整会话、工具输出、用户文件、配置密钥和内存转储均不打包。读不到某类日志时在 manifest 标记缺失。

日志创建/写入/轮转异常被隔离，不替换原始业务异常。Node 写入队列有上限；日志不可写或出现丢弃时，诊断界面显示受限状态。原始业务保存失败仍按既有执行规则处理，不会为了“成功记日志”伪造任务成功。磁盘无法写入时，最后任务状态本身也可能无法更新，恢复依然需要可用的存储。

## 开发者定位

1. 在三个进程日志中搜索客户的 `D-…` 编号，确认首次失败时间和 error_type/error_code。
2. 用 task_id/session_id 串起调用链；模型请求用 request_id 区分尝试，用 provider_request_id 对照服务商记录；RPC 用 rpc_id 定位跨进程失败。
3. 工具问题使用 tool_call_id 查现有事件/工具记录。诊断日志不再复制工具全文。
4. 卡住问题结合 phase、phase_since、last_activity 和 task_wait_observed 判断等待位置；仅有耗时告警不能证明死锁。多 Agent 的阶段是任务级概要。

例如，在日志目录执行 `rg 'D-xxxxxxxxxxxxxxxx' .`，再用找到的 task_id 查询同目录。需要查看业务内容时应由用户明确选择对应会话或文件，诊断导出不会隐式读取用户工作区。

## 分层接口

| 层 | 职责与接口 |
| --- | --- |
| 桌面展示层 | 通过 DesktopApi 调用诊断状态/导出；只展示中文摘要 |
| 桌面传输层 | GatewayClientPort / GatewayClient 负责 HTTP；preload/IPC 负责跨 Electron 边界 |
| Gateway 传输层 | Fastify 依赖 TaskStore 接口；LocalTaskStore 负责 Python JSON-lines RPC |
| Python 传输层 | JsonLineRpcServer 只依赖方法表，不创建 AgentRuntime 或数据库 |
| Python 业务层 | AgentRuntime、TaskInteraction、TaskEventSink 通过 StoragePort 连接数据层；工作记忆依赖已有 WorkingMemoryStore |
| 数据层 | LocalStorage 负责 SQL/事务/恢复；SQLiteWorkingMemoryStore 实现工作记忆接口 |
| 诊断基础设施 | Node DiagnosticPort 接口连接 Pino/轮转/ZIP；Python logging 与 SDK Model 接口适配器负责观测 |
| 装配入口 | runtime/bootstrap.py 的 create_runtime() 选择 SQLite 和工作记忆实现；__main__.py 装配业务方法与 RPC |

`AgentRuntime` 的构造函数接收 `storage`、`memory`、`journal_factory` 与 `verifier` 接口。默认本地服务使用 `create_runtime(directory)`，测试可以注入替代实现。主运行链路已按分层目录整理，现有执行循环、审批、暂停、取消、上下文事务和恢复策略保持原有职责。目录和依赖规则见 [软件架构说明](ARCHITECTURE.md)。

## 验证边界

自动化覆盖 HTTP 错误/重试、流式传输异常及无完成标记 EOF、网络超时、取消等级、SQLite 只读失败、文件 ENOSPC、轮转/过期清理、脱敏、日志不可写、离线诊断包导出，以及真实 Python 子进程退出。

`scripts/accept-diagnostics.mjs <exe>` 启动真实打包 Electron、Gateway、Python 和 SQLite，使用本机模型夹具检查 HTTP 401、流中断、等待阶段、取消、空会话诊断入口、界面触发的 ZIP 导出及脱敏，保存验收 JSON 和截图。保存对话框的“用户选定路径”通过测试替身提供，未自动操作系统原生文件选择窗口。

尚未验证真实服务商、真实断网/系统断电、OS/native 崩溃与内存转储分析；没有真实 Docker、Redis/PostgreSQL 环境的测试会跳过。诊断窗口的阶段是从现有事件推导，旧数据或超出有限事件窗口的历史可能只能显示“正在处理”。同步摘要任务被取消后，线程中的 HTTP 请求仍遵循其原有超时行为，日志功能不改变这一语义。

实现时核对了[OpenAI 请求调试说明](https://developers.openai.com/api/reference/overview)及当前安装的 SDK 源码。模型配置和重试策略继续由已有 SDK/调用方管理。
