# Bit Agent Multi-Agent

更新日期：2026-09-09。本轮代码尚未运行验证。

## 默认桌面链路：关闭、开启、智能

现在不先调用 Planner 分类。主 Agent 的工具列表由用户选择的模式决定。
关闭时没有 `delegate_tasks`；开启时提示模型优先分工；智能时模型自己决定是否调用。
不存在一套按字数或关键词决定要不要多 Agent 的新规则。

每批最多 3 个只读子 Agent，每轮任务最多 2 批，不能递归创建帮手。
它们只读和搜索代码，主 Agent 检查结果并统一修改，不让多个帮手直接同时写同一文件。
实现位于 `services/agent/src/bit_agent/runtime/application/delegation.py`。

**以下章节保留的是旧 `run_multi_agent` 编排接口，用于兼容入口和评测，不是默认桌面执行路径。**
新的主流程见 [本地运行](LOCAL_RUNTIME.md)。

## 先路由，再决定是否启动多个 Agent

用户输入先分为两类：

| 路由 | 适用输入 | 行为 |
| --- | --- | --- |
| `direct` | 寒暄、闲聊、身份或能力询问 | 直接请求模型回答；不读取仓库、不调用工具、不创建子 Agent。 |
| `repo` | 创建、查看、分析、修改、测试或构建代码 | 生成调查任务，并进入完整 Multi-Agent 代码链路。 |

短寒暄有确定性规则，避免为“你好，在吗”额外请求一次规划模型。其他输入由 Planner
返回 `route`。`direct` 计划必须是空 `tasks`，`repo` 计划必须至少包含一个任务；数据模型
会同时校验这两个约束，避免只改提示词后又错误降级成代码调查任务。

是否选择了空项目不决定路由。“你好”在任何工作区都是 `direct`；“在空目录创建一个
Python 项目”仍然是 `repo`。

## 为什么要有多个 Agent

一项任务可能需要同时看代码、看测试、找相关模块。多个子 Agent 可以分头调查，最后让主 Agent 把证据放在一起处理。

当前做法是“多人调查，一人改代码”。这样不会让多个 Agent 同时写同一个文件。子 Agent 所谓的只读，是不允许改项目源码；它仍然可以在自己的副本里运行受控测试。

## 目录里的文件分别负责什么

以下文件位于 `services/agent/src/bit_agent/multi_agent`：

| 文件 | 用途 |
| --- | --- |
| `planner.py` | 把任务拆成有依赖关系的小任务。 |
| `models.py` | 规定任务、计划、子结果和总结果的格式。 |
| `dispatcher.py` | 按依赖和并发规则启动子 Agent。 |
| `workspace.py` | 创建和清理隔离工作区。 |
| `aggregator.py` | 汇总证据，记录冲突。 |
| `orchestrator.py` | 把规划、调查、汇总和主 Agent 串起来。 |

DAG 指没有循环依赖的任务图。例如“先查清接口，再检查调用方”有先后顺序；互不依赖的调查可以同时进行。

## 完成和部分完成

主 Agent 失败时，整体会失败。主 Agent 完成之后，如果所有子调查也完成且没有汇总冲突，整体为 `COMPLETED`；否则可能为 `PARTIAL`。

所以 `PARTIAL` 不一定代表最终代码只写了一半。需要打开子任务结果和冲突说明，看看缺了哪些调查证据。

Multi-Agent V1 使用“并发调查、单点修改”模型：

```text
用户输入
→ Planner 判断 direct / repo
→ direct：模型直接回答并结束
→ repo：生成任务 DAG
  → TaskDispatcher 并发运行隔离的只读子 Agent
  → ResultAggregator 检测冲突并压缩证据（默认单项 4,000 字符、总计 12,000 字符）
  → 主 Agent 在真实工作区验证、修改和运行 Docker 测试
→ MultiAgentRunResult
```

子 Agent 只能使用 `list_files`、`read_file`、`search_code` 和 `run_tests`。
`apply_patch` 不会出现在其 Tool Schema 中，即使模型主动申请也会被框架拒绝。
每个子 Agent 使用独立工作区副本和独立对话历史，结束后副本自动清理。

调用入口：

```python
from pathlib import Path

from bit_agent.multi_agent import run_multi_agent

result = await run_multi_agent(
    "定位并修复当前项目的失败测试",
    workspace_root=Path("target-repository"),
)
print(result.model_dump_json(indent=2))
```

真实端到端评测：

```powershell
python services/agent/evals/run_multi_agent_bug_fix.py
```

返回结果包含规划来源和路由。`repo` 还包含任务 DAG、每个子 Agent 回执、聚合冲突、
主 Agent 工具轨迹、修改文件和测试状态；`direct` 的子 Agent 列表为空，测试和 Ruff 状态
为未运行。Planner 输出不合法时会重试，仍失败的仓库任务会降级为代码调查与测试调查
两个确定性任务。
> 2026-09-09 验收更新：本地运行链路已通过回归和真实 Electron 串联检查。文中早先的“未验收”描述是修改阶段的记录；最新结果及未覆盖范围见 [本地版验收报告](ACCEPTANCE_LOCAL_RUNTIME.md)。
