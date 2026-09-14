# Gateway 和 Worker：谁接单，谁干活

更新日期：2026-09-09。本轮代码尚未运行验证。

## 当前默认入口

默认链路已改为 `Desktop -> Gateway -> 本机 Python AgentRuntime -> SQLite/文件`。
Gateway 的 `local-task-store.ts` 负责启动执行进程、发送请求和接收回复，不再要求 Redis。
会话编号连接多轮消息，任务编号区分每次执行。详见 [本地运行](LOCAL_RUNTIME.md)。

**以下 Redis / Worker 章节保留为旧模式说明。只有设置 `BIT_AGENT_RUNTIME=redis` 才使用这条链路；
它不是默认桌面入口，也没有新本地会话的三档模式语义。**

Gateway 是接单窗口，Worker 是实际执行任务的程序。Redis 负责保存排队任务、任务状态和实时事件，让两个程序不用挤在同一个进程里。

```text
Desktop / CLI
  -> Gateway 收到 HTTP 请求
  -> Redis 保存并排队
  -> Python Worker 领取
  -> Multi-Agent 调查和主 Agent 执行
  -> Redis 保存状态和事件
  -> Gateway 把结果返回给客户端
```

## 三部分各自负责什么

| 部分 | 负责什么 | 主要代码 |
| --- | --- | --- |
| Gateway | 检查请求格式，创建、查询、取消任务，转发实时事件。 | `apps/gateway/src` |
| Redis | 存任务队列、任务记录、事件流和 Worker 使用的工作记忆。 | 外部服务，由 `infra/runtime` 配置 |
| Worker | 检查实际工作区，调用 Multi-Agent，处理超时、取消和结果回写。 | `services/agent/src/bit_agent/worker` |

Gateway 会检查工作区路径是否为绝对路径，但不负责读取和分析仓库内容。实际工作区访问发生在执行端。

## 当前默认接了什么

Worker 默认调用统一编排入口。编排器先判断 `direct` 或 `repo`：普通对话直接回答；代码任务才调用 Multi-Agent，并把 Redis 工作记忆存储传给子 Agent 和主 Agent。主 Agent 的代码修改由运行框架要求通过 pytest 和覆盖改动文件的 Ruff lint。

空工作区是合法工作区，不会自动取消任务，也不会自动触发代码扫描。`CANCELLED` 只表示
Gateway 收到了取消请求；Worker 超时或模型异常会记录为 `FAILED`。

普通 Worker 启动没有自动创建 PostgreSQL 长期记忆库、Embedding Provider、召回器或巩固器。因此不启用长期记忆时，不需要为了启动普通任务额外启动 Ollama 或 PostgreSQL。

## 启动顺序

在项目根目录安装依赖：

```powershell
./.venv/Scripts/python.exe -m pip install -e ".[dev,memory]"
pnpm install
```

启动 Docker Desktop，然后启动开发 Redis：

```powershell
docker compose --file infra/runtime/compose.dev.yaml up --detach --wait
```

分别在两个终端启动：

```powershell
./.venv/Scripts/python.exe -m bit_agent.worker
```

```powershell
pnpm --dir apps/gateway dev
```

也可以用 `pnpm --dir apps/gateway start` 启动不带源码监视的 Gateway。聊天模型的 `API_KEY`、`BASE_URL`、`MODEL_NAME` 需要配置好。

## 常用配置

| 变量 | 默认值或含义 |
| --- | --- |
| `BIT_AGENT_REDIS_URL` | 默认 `redis://127.0.0.1:6379/0`，Gateway 和 Worker 应连接同一套队列。 |
| `HOST`、`PORT` | Gateway 默认监听 `127.0.0.1:3000`。 |
| `BIT_AGENT_WORKER_ID` | 可指定 Worker 编号；不填时自动生成。 |
| `BIT_AGENT_TASK_TIMEOUT_SECONDS` | Worker 默认单任务超时 3600 秒。 |
| `BIT_AGENT_GATEWAY_URL` | CLI 使用的 Gateway 地址。 |

开发用 Redis 和集成测试 Redis 使用不同配置文件和端口，不要把二者当成同一个服务。

## HTTP 接口

| 请求 | 用途 |
| --- | --- |
| `GET /health` | 查看 Gateway 进程的健康响应；不等于完整任务链路已经验证成功。 |
| `POST /v1/tasks` | 新建任务，成功接收返回 202。 |
| `GET /v1/tasks/{task_id}` | 查任务状态和时间等信息。 |
| `GET /v1/tasks/{task_id}/events` | 接收持续推送的 SSE 事件。 |
| `GET /v1/tasks/{task_id}/result` | 查结束后的结果；没结束返回 409。 |
| `DELETE /v1/tasks/{task_id}` | 请求取消任务。 |

创建任务的 JSON 示例：

```json
{
  "objective": "修复项目中失败的测试并验证",
  "workspace_root": "D:/workspace/demo"
}
```

SSE 是服务端持续向客户端发送消息的 HTTP 连接。断线后可以使用 `Last-Event-ID` 或 `after` 查询参数接着读取。事件流不是需要你手工编辑的配置文件。

任务状态详见 [状态说明](STATE_MACHINE.md)，Redis 字段约定见 [协议说明](../packages/protocol/README.md)。

## 开发时怎样验证

以下是手动检查入口，本轮文档更新没有执行它们：

```powershell
./.venv/Scripts/python.exe -m pytest services/agent/tests/test_worker.py
pnpm --dir apps/gateway test
pwsh -File infra/runtime/run-integration-tests.ps1 -StopAfter
```

最后一条会启动独立的测试 Redis，运行 Gateway 和 Worker 的真实 Redis 协议测试。普通开发服务配置见 [infra 说明](../infra/README.md)。
> 2026-09-09 验收更新：本地运行链路已通过回归和真实 Electron 串联检查。文中早先的“未验收”描述是修改阶段的记录；最新结果及未覆盖范围见 [本地版验收报告](ACCEPTANCE_LOCAL_RUNTIME.md)。
