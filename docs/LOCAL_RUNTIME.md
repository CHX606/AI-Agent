> 最新权限、暂停、审阅和独立包见 [功能说明](PRODUCT_HARDENING.md)，验收边界见 [最新报告](ACCEPTANCE_PRODUCT_HARDENING.md)。

# 本地运行：现在先从这里读

更新日期：2026-09-09。默认本地链路已做回归和桌面串联验收，外部环境仍需单独验证。

## 默认链路

```text
Electron 桌面 -> Gateway -> 本机 Python AgentRuntime -> 模型和工具
                                      |
                               SQLite + 本地文件
```

模型服务仍可以是远程 API；读取和修改项目文件由本机的工具执行。
本地进程之间直接通信，不代表把任务交给云端，也不要求额外安装数据库服务。

## 启动

依赖已经安装、根目录 `.env` 已配置聊天模型后，在项目根目录运行：

```powershell
pnpm desktop:dev
```

这条命令先构建桌面，再启动 Gateway 和 Electron。Gateway 自动启动 Python 本地运行服务。
不需要先开 Redis，也不需要再运行旧的 `python -m bit_agent.worker`。
如果已经手动启动 Gateway，使用 `pnpm desktop:only` 打开界面，避免重复占用端口。
单独开发 Gateway 可以用 `pnpm gateway:dev`。

以上是源码开发启动。独立便携版由 `pnpm desktop:package` 生成，双击发布目录内的 `Bit Agent.exe`；随包附带运行时，不需要系统 Node/Python。它不是单文件或已签名安装包，隔离测试仍需要 Docker。

## 怎样使用

1. 选择文件夹，点击新建任务，发送第一条消息。
2. 后续在同一个对话发送消息，自动带上之前的历史，不需要重复贴完整要求。
3. 左侧可以新建和切换对话；后台任务不会因为切换对话而被取消。
4. 关闭、开启、智能三个按钮影响下一次发送的任务，执行期间不能更改当前任务模式。
5. 重新打开后，从服务器保存的会话列表恢复，不依赖浏览器只缓存的最近几条标题。

同一文件夹的写任务会排队。不同对话并不等于不同代码副本。
关闭应用会停止本地运行；再次打开可以查看历史并继续提问，但不会悄悄重跑被中断的工具。

## 阅读顺序

### 2026-09-10：两种数据各存各的

| 存放位置 | 保存什么 | 重新打开会话时给谁读取 |
| --- | --- | --- |
| `context_state` 表 | 历史消息、工具调用及结果、历史中的压缩摘要消息 | Context Manager |
| `working_memory` 表 | 目标、要求、计划、已读和已改文件、错误、验证状态、已处理的补充要求编号 | Working Memory Tracker |

摘要已经是上下文历史里的一条消息，不再另外塞一份到工作记忆。
恢复时用同一个会话编号分别读取两张表，不创建第三份混合状态。
保存时，两张表在同一次事务里更新：要么都成功，要么都不更新，防止突然退出造成进度错位。

旧 `checkpoints` 表会直接改名为 `context_state`，不是再复制一张表。
首次读取旧会话时，兼容逻辑会搬回放错位置的数据，然后按新格式保存。
已有工作记忆是任务状态的依据；若旧上下文副本与它不一致，会从任务记录重读用户补充要求，
而不是直接用旧副本覆盖当前状态。旧格式迁移失败时保留原记录，不用空数据覆盖。

这次只调整本地 SQLite 会话。旧 Redis 路径的历史数据不会自动导入或迁移。
本次测试结果以本轮回复为准，下方旧验收报告不代表这次修改已经通过验收。

### 从哪里开始读代码

先读 [runtime 的大白话说明](../services/agent/src/bit_agent/runtime/README.md)，
再读 `runtime/application/service.py` 的 `create_task` 和 `_execute`。
理解主流程以后，再按需要看 `runtime/infrastructure/storage.py` 或 `runtime/application/delegation.py`，不必一上来逐行读 SQL。目录分层和接口依赖见 [架构说明](ARCHITECTURE.md)。

Gateway 的对应入口是 `apps/gateway/src/infrastructure/runtime/local-task-store.ts`。
它只负责启动 Python 和传递消息，不应该再自行处理上下文、工作记忆或分工。

## 兼容旧代码

`BIT_AGENT_RUNTIME=redis` 可选择旧的 Redis 路径，需要自己启动 Redis 和旧 Worker。
旧路径不提供新本地会话的恢复及三档模式语义，旧测试和底层适配器保留。
PostgreSQL 长期记忆仍是可选能力，没有删除；普通本地聊天不会默认启用向量记忆。
旧 Redis 任务没有自动导入 SQLite，历史数据仍留在原来的存储中。
> 2026-09-09 验收更新：本地运行链路已通过回归和真实 Electron 串联检查。文中早先的“未验收”描述是修改阶段的记录；最新结果及未覆盖范围见 [本地版验收报告](ACCEPTANCE_LOCAL_RUNTIME.md)。
