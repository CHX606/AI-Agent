# 执行记录：出了问题去哪里找过程

更新日期：2026-09-04。

Observability 在这里可以理解成“让执行过程看得见”。Agent 最后一句“已完成”信息太少，我们还需要知道它什么时候调用模型、读了哪些文件、运行了什么工具、在哪一步出错。

## 事件和最终结果分别是什么

事件像一条条过程记录，例如“开始规划”“工具返回”“任务结束”。最终结果是整次任务的回执，包含状态、回答、修改文件、工具轨迹和验证标志等信息。

要看顺序和耗时，先看事件。要看一次工具的完整结果，查看对应运行回执中的工具记录或相关产物。

## 事件里常见的字段

| 字段 | 大白话含义 |
| --- | --- |
| `trace_id` | 整条执行过程的关联编号。 |
| `run_id` | 某次运行的编号。 |
| `agent_id` | 哪个 Agent 发出的事件。 |
| `task_id` | 关联的任务编号，部分场景可以为空。 |
| `sequence` | 在同一个事件总线中的先后顺序。 |
| `event_type` | 发生了什么，例如 `TOOL_COMPLETED`。 |
| `timestamp` | 发生时间。 |
| `payload` | 这条事件附带的具体信息。 |

这些字段用于关联同一件事，并不是一串文件夹路径。并发子 Agent 共用事件总线时，也会获得递增的顺序号。

## 数据可能存在哪里

| 位置或形式 | 用途 |
| --- | --- |
| `artifacts/events/*.jsonl` | 文件形式的事件记录，一行一个 JSON。 |
| Redis Stream | Worker 把事件写到这里，让 Gateway 实时读取。 |
| Gateway SSE | 把事件持续推送给 Desktop 或 CLI。 |
| `.test-runs/.../artifacts/events.sse` | 某次运行保存下来的 SSE 文本记录。 |
| `.test-runs/.../artifacts/gateway-result.json` | 某次任务保存下来的最终回执。 |

默认运行可以写 JSONL；Worker 会注入 Redis 事件接收器。实际生成哪些文件，以该次运行的配置和结果中的路径为准，不能要求每个任务都生成完全相同的目录。

JSONL 每行就是一个完整对象；SSE 通常有 `id:`、`event:`、`data:` 和空行，不应直接当成一个普通 JSON 文件解析。

## 去哪里找问题

1. 看最终状态和 `error`，确认是失败、取消，还是部分完成。
2. 看 `tests_passed` 和 `quality_checks_passed`，确认记录里有什么验证证据。
3. 根据 `tool_call_id` 和事件顺序定位相关工具。
4. 查看工具输出或关联产物，理解实际错误原因。

旧记录可能没有后来新增的字段。缺少字段不应自行解释成“已通过”。

## 程序怎样写事件

`EventBus` 负责分配编号，`EventSink` 负责把事件放进具体存储。现有接收器包括内存、JSONL 文件和 Redis。

```python
from bit_agent.observability import InMemoryEventSink

sink = InMemoryEventSink()
result = await run_multi_agent(task, workspace_root=workspace, event_sink=sink)
```

单个接收器写入失败会记录到 `event_warnings`，不会因为一份日志写失败就直接让 Agent 中断。

运行代码通常发送耗时、数量、状态和路径摘要；事件模型本身允许结构化 payload，并不自动把任意调用方传入的全部内容脱敏。

实现位置：`services/agent/src/bit_agent/observability/events.py`。目录说明见 [artifacts](../artifacts/README.md)。
