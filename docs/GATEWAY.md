# Gateway：接收任务并转交本地执行进程

Gateway 是接单窗口：检查请求格式，创建、查询、取消任务，并把执行事件通过 SSE 推给客户端。
它不读取、也不分析仓库内容；实际执行发生在它启动的本机 Python AgentRuntime 中。

```text
Desktop / CLI
  -> Gateway 收到 HTTP 请求
  -> local-task-store.ts 通过进程管道（JSON RPC）交给 Python AgentRuntime
  -> AgentRuntime 执行任务，把任务、会话和事件保存到 SQLite
  -> Gateway 读取状态和事件，返回给客户端
```

会话编号连接多轮消息，任务编号区分每次执行。启动方式和数据目录见 [本地运行](LOCAL_RUNTIME.md)。

> 2026-09 之前还有一条 Redis 队列 + Python Worker 的旧链路，已经删除。
> 需要查看旧实现时，检出 git 标签 `legacy-redis`。

## 各部分负责什么

| 部分 | 负责什么 | 主要代码 |
| --- | --- | --- |
| HTTP 路由 | 校验请求、鉴权、SSE 推送。 | `apps/gateway/src/transport/http/app.ts` |
| 本地运行适配器 | 启动 Python 子进程、发送 RPC、处理超时。 | `apps/gateway/src/infrastructure/runtime/local-task-store.ts` |
| AgentRuntime | 执行任务、保存会话和事件。 | `services/agent/src/bit_agent/runtime` |

Gateway 会检查工作区路径是否为绝对路径。空工作区是合法工作区，不会自动取消任务。
`CANCELLED` 只表示 Gateway 收到了取消请求；执行超时或模型异常会记录为 `FAILED`。

## 启动

```powershell
pnpm --dir apps/gateway dev
```

`start` 启动不带源码监视的 Gateway。聊天模型的 `API_KEY`、`BASE_URL`、`MODEL_NAME` 需要配置好。
平时使用 `pnpm desktop:dev` 即可，它会一起启动 Gateway 和桌面窗口。

## 常用配置

| 变量 | 默认值或含义 |
| --- | --- |
| `HOST`、`PORT` | Gateway 默认监听 `127.0.0.1:3000`。 |
| `BIT_AGENT_GATEWAY_TOKEN` | 设置后，所有请求都要带 `Authorization: Bearer <token>`；桌面主进程会自动设置。 |
| `BIT_AGENT_TASK_TIMEOUT_SECONDS` | 单任务超时，默认 3600 秒。 |
| `BIT_AGENT_DATA_DIR` | 会话数据目录，默认 Windows 用户的 `LocalAppData/BitAgent/runtime`。 |
| `BIT_AGENT_GATEWAY_URL` | CLI 使用的 Gateway 地址。 |

## HTTP 接口

| 请求 | 用途 |
| --- | --- |
| `GET /health` | Gateway 与本地执行进程的健康状态。 |
| `POST /v1/tasks` | 新建任务，成功接收返回 202。 |
| `GET /v1/tasks/{task_id}` | 查任务状态和时间等信息。 |
| `GET /v1/tasks/{task_id}/events` | 接收持续推送的 SSE 事件。 |
| `GET /v1/tasks/{task_id}/result` | 查结束后的结果；没结束返回 409。 |
| `DELETE /v1/tasks/{task_id}` | 请求取消任务。 |
| `POST /v1/tasks/{task_id}/interaction` | 运行中补充要求、回答提问、暂停或继续，见 [交互说明](INTERACTION.md)。 |
| `GET`/`POST /v1/tasks/{task_id}/changes` | 查看和审阅（保留或撤销）本次任务的文件改动。 |
| `GET /v1/sessions`、`GET /v1/sessions/{session_id}` | 会话列表和详情。 |
| `PATCH /v1/sessions/{session_id}` | 切换多 Agent 模式（`off`、`on`、`auto`）。 |
| `GET /v1/memories?workspace_root=...` | 本项目（省略参数时为全部项目）的长期记忆，见 [记忆说明](MEMORY.md)。 |
| `DELETE /v1/memories/{memory_id}` | 删除一条长期记忆，之后不再参与召回。 |
| `POST /v1/model` | 桌面主进程写入模型配置（含接口类型 `api`）；需要设置 `BIT_AGENT_GATEWAY_TOKEN`。 |
| `GET /v1/sessions?query=` | `query` 非空时只返回标题、任何一轮要求或回答中包含它的对话。 |
| `PATCH /v1/sessions/:sessionId` | 传 `title` 重命名对话；传 `multi_agent_mode` 修改多 Agent 模式。 |
| `DELETE /v1/sessions/:sessionId` | 删除对话的全部记录和改动快照；正在执行的对话返回 409。 |
| `GET /v1/tasks/:taskId/git` | 这次任务改过的文件在 Git 里的状态和当前分支。 |
| `POST /v1/tasks/:taskId/git/message` | 用当前模型根据目标和差异起草提交信息，模型不可用时返回按目标生成的草稿。 |
| `POST /v1/tasks/:taskId/git/commit` | 只提交这次任务的文件；`branch` 可选，填写时先新建分支。 |
| `POST /v1/model/test` | 桌面主进程用一次真实请求测试模型配置，`api` 为 `auto` 时自动检测接口类型；不改变当前配置；同样需要令牌。 |
| `GET /v1/diagnostics` | 诊断快照，见 [桌面诊断](DESKTOP_DIAGNOSTICS.md)。 |

创建任务的 JSON 示例：

```json
{
  "objective": "修复项目中失败的测试并验证",
  "workspace_root": "D:/workspace/demo"
}
```

SSE 是服务端持续向客户端发送消息的 HTTP 连接。断线后可以使用 `Last-Event-ID` 或 `after` 查询参数接着读取。

任务状态详见 [状态说明](STATE_MACHINE.md)。

## 开发时怎样验证

```powershell
pnpm --dir apps/gateway test
```

真实本地执行链路的集成测试默认跳过，设置 `BIT_AGENT_TEST_LOCAL_RUNTIME=1` 后运行。
