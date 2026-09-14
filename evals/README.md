# evals：给 Agent 准备的题目

这个目录主要放示例工作区，帮助观察 Agent 是否能理解代码、调用工具并完成具体任务。

它和 `services/agent/tests` 不同：后者测试我们写的程序，这里的题目更关注 Agent 做事的效果。

## 当前示例

| 目录 | 用途 | 当前代码情况 |
| --- | --- | --- |
| `fixtures/calculator_bug` | 简单计算器故障题。 | 原题保留错误，供副本修复。 |
| `fixtures/agent_loop_a_plus_b` | 极小的加法和测试示例。 | 当前已有正常相加实现。 |
| `fixtures/workflow_engine_build` | 让 Agent 补完依赖图、调度器和报告。 | 原题保留空实现。 |

“原题还没实现”和“运行后的副本已经完成”可以同时成立。副本的状态要去 `workspaces` 或对应的 `.test-runs` 目录看。

## 为什么还有另一处 evals

`services/agent/evals` 放真实 Agent 评测脚本，以及脚本使用的计算器原题；`services/agent/src/bit_agent/evals` 放评测器的实现。

这几处名字相同但层级和用途不同。脚本最终用哪份题，以脚本中的 `fixture_path` 为准。

## 题目里的 tests 和 README

`tests` 是验收规则；README 描述题目背景和要求。不要为了得到通过结果而把规则改松。

我们这次更新题目说明，只澄清原题身份、目录用途和现有副本状态，没有修改题目源码或验收测试。

## 结果在哪里

独立评测通常把结果放到根目录 `artifacts/evals`。手工联调也可能把工作区和回执一起保存在 `.test-runs`。

查看 [运行副本说明](../.test-runs/README.md) 可以理解你之前打开的工作流引擎记录。
