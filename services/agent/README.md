# Python Agent：实际执行任务的部分

这个目录保存 Bit Agent 的 Python 源码、测试和评测入口。它负责接模型、找代码、调工具、记录结果，以及和 Gateway 配合处理用户任务。

如果你想开始理解“AI 是怎么一步步改代码的”，这里是最值得读的部分。

## 先看三个大目录

| 目录 | 用途 |
| --- | --- |
| `src/bit_agent` | 程序真正使用的源码。 |
| `tests` | 检查 Bit Agent 自己的功能有没有按预期工作。 |
| `evals` | 让 Agent 实际做一道修复题的脚本和原题。 |

Python 项目的依赖和测试配置统一在根目录 `pyproject.toml`。不用因为这里有一个 agent 目录就再单独建立另一套环境。

## 推荐阅读顺序

1. `worker/service.py`：看看任务如何被领取、执行和回写。
2. `multi_agent/orchestrator.py`：看看完整任务如何拆分和汇总。
3. `agent/runtime.py`：看看一个 Agent 如何反复调用模型和工具。
4. `llm/tool_schemas.py`：看看模型被允许调用哪些工具。
5. `tools`：看工具实际上怎样读文件、改文件和检查结果。
6. `tests`：结合用例理解预期行为。

前五项的源码路径均相对于 `src/bit_agent`。

## 其他模块怎样配合

| 模块 | 用途 |
| --- | --- |
| `context` | 找相关代码、提取片段、整理和压缩模型输入。 |
| `memory` | 记录任务进度，以及可选的长期经验存储和召回。 |
| `sandbox` | 调用 Docker 运行隔离测试和检查。 |
| `security` | 限制路径访问范围。 |
| `tool_provider` | 在本地工具、MCP 和权限限制之间做适配。 |
| `mcp_server` | 把工具作为 MCP 服务提供出去。 |
| `observability` | 保存有顺序的执行事件。 |
| `client`、`cli.py` | 从终端调用 Gateway。 |
| `models` | 代码索引和仓库地图的数据结构。 |
| `evals` | 独立验收 Agent 结果的程序实现。 |

## 在根目录启动 Worker

```powershell
./.venv/Scripts/python.exe -m bit_agent.worker
```

需要配置聊天模型并先启动 Redis；执行测试和检查还需要 Docker 环境。

普通 Worker 默认接入 Redis 工作记忆，不会自动把 PostgreSQL 长期记忆和向量服务全部启用。具体接入见 [记忆说明](../../docs/MEMORY.md)。

## 测试和评测结果怎么看

根目录运行 `python -m pytest` 时，默认测试路径是这里的 `tests`。测试结果描述的是它们检查到的场景。

`evals/run_bug_fix.py` 和 `evals/run_multi_agent_bug_fix.py` 则会让 Agent 在隔离副本中做题，再由评测器验收。结果通常写到根目录 `artifacts/evals`。
