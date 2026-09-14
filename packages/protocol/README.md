# Gateway / Worker 协议：两个程序怎样对得上话

更新日期：2026-09-04。

Gateway 用 TypeScript 写，Worker 用 Python 写。它们需要对“任务编号叫什么、状态有哪些、事件放在哪里”有相同理解。这个目录保存的就是这些约定。

当前这里主要是协议说明，不是已经打包好的、自动供两种语言共用的运行时代码。实际模型分别维护在 `apps/gateway/src/protocol.ts` 和 `services/agent/src/bit_agent/worker/models.py`。

## Redis 中放什么

| Key | 作用 |
| --- | --- |
| `bit-agent:tasks:queue` | 等待执行的任务列表。 |
| `bit-agent:tasks:processing` | Worker 已领取、尚未确认处理结束的任务。 |
| `bit-agent:tasks:{task_id}` | 这项任务的状态记录。 |
| `bit-agent:tasks:{task_id}:events` | 这项任务的实时事件流。 |

Gateway 用 `RPUSH` 放入队列；Worker 用 `BLMOVE LEFT RIGHT` 领取并放进处理中列表。可以理解为从“待办栏”移到“正在做”。

## 队列任务的基本字段

| 字段 | 意思 |
| --- | --- |
| `task_id` | 任务编号。 |
| `objective` | 用户要求完成什么。 |
| `workspace_root` | Worker 要操作的项目绝对路径。 |
| `created_at` | 创建时间。 |

完整任务记录还包括开始和结束时间、Worker 编号、结果和错误等信息。

## 状态约定

正常执行是 `QUEUED -> RUNNING -> COMPLETED / PARTIAL / FAILED`。

排队时取消可进入 `CANCELLED`；运行时取消先进入 `CANCELLATION_REQUESTED`，再由执行端处理。终态只有 `CANCELLED`、`COMPLETED`、`PARTIAL`、`FAILED`。

`PARTIAL` 的具体含义见 [任务状态说明](../../docs/STATE_MACHINE.md)。不要把旧设计中的 `SUCCEEDED` 当成当前协议状态。

## 什么时候需要改这里

增加接口字段、修改任务状态或调整 Redis 约定时，需要同时检查两边的实现和协议测试。仅改这份 README，不会自动改变 Gateway 或 Worker 的行为。
