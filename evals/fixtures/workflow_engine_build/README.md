# Workflow Engine Build：工作流引擎评测原题

更新日期：2026-09-04。

## 这个目录的身份

这里保存的是一道给 Agent 做的编程题。当前 `graph.py`、`scheduler.py`、`reporting.py` 仍故意保留 `NotImplementedError`，表示让 Agent 在副本中补完实现。

这里的“未完成”描述的是原始题目，不是说 Bit Agent 整个项目还没有完成，也不是说某次运行副本一定没做完。

已检查的 `.test-runs/workflow-engine-f07cd13585f643ef924e61d78e2c6d98/workspace` 是另一份运行副本，其中已有实现，历史记录显示当时 23 项测试通过。两份目录承担不同作用。

## 工作流引擎是什么

可以把它理解成一个“按先后关系安排任务”的小程序。例如先下载资料，再处理资料，最后生成报告；两个互不依赖的步骤可以同时做。

| 内容 | 用途 |
| --- | --- |
| `workflow_engine/models.py` | 定义步骤、工作流、状态和结果长什么样。 |
| `workflow_engine/errors.py` | 定义不同错误的名称。 |
| `workflow_engine/graph.py` | 检查依赖是否合理，算出执行顺序。 |
| `workflow_engine/scheduler.py` | 按依赖执行步骤，处理失败和跳过。 |
| `workflow_engine/reporting.py` | 汇总执行结果，生成文字报告。 |
| `tests` | 题目的验收测试。 |
| `README.md` | 题目说明和规则。 |

下面保留原题要求。进行做题评测时应操作隔离副本；不要为了得到通过结果而修改测试规则。

## 行为要求

### 工作流校验

- 工作流至少包含一个步骤。
- `Step.id` 和 `Step.action` 去除首尾空白后不能为空。
- 步骤 ID 不能重复。
- 同一步骤不能重复声明依赖、依赖自身或依赖未知步骤。
- 工作流不能包含依赖环。
- 校验错误统一抛出 `WorkflowValidationError` 的对应子类。

### 图分析

- `topological_layers()` 返回可并行执行的拓扑层。
- 同一层及依赖集合必须保持步骤在 `Workflow.steps` 中的原始顺序。
- `transitive_dependencies()` 返回指定步骤的全部传递依赖；未知步骤抛出 `KeyError`。

### 调度

- Action 可以是同步函数，也可以是异步函数。
- Action 接收当前 `Step` 和一个只读映射；映射只包含直接依赖的成功输出。
- 同一拓扑层并发执行，但并发数不能超过 `max_concurrency`。
- Action 返回值保存为 `StepResult.output`。
- 未注册的 Action 或 Action 抛出的普通异常转换为 `FAILED`，不能让整个 Runner 崩溃。
- 依赖不是 `SUCCESS` 时，下游步骤标记为 `SKIPPED`，且不调用 Action。
- 默认情况下，一个分支失败不能阻止无依赖关系的其他分支。
- `fail_fast=True` 时，失败所在层执行结束后，后续所有步骤均跳过。
- 最终结果顺序必须始终与 `Workflow.steps` 一致。
- 外部取消产生的 `asyncio.CancelledError` 必须继续向上抛出。

### 报告

- `summarize()` 返回每种 `StepStatus` 的数量。
- `render_text()` 返回稳定的纯文本报告，包含总体状态以及各状态的步骤 ID。

不得修改测试文件。
