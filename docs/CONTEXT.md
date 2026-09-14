# Bit Agent Context Manager

更新日期：2026-09-10（拆开上下文和任务状态的存储）。

本次存储调整与下方旧验收报告不是同一次验收；本次测试结果以本轮回复为准。

2026-09-09 补充：默认本地运行库会保存整个会话可继续的历史；上下文压缩仍由本模块负责。
下面的 `artifacts/context/` 是直接调用旧入口时的位置。默认桌面链路将大型结果放在用户数据目录的
`BitAgent/runtime/artifacts/<task_id>/` 中，而不是被操作项目里。详细路径见 [本地运行](LOCAL_RUNTIME.md)。
本轮修改未运行验证。

## 先用大白话理解

模型每次回答前，都需要收到任务、已读代码和前面工具的结果。这些内容越积越多，可能超过模型一次能接收的长度，或者让每轮请求变得很大。

Context Manager 就负责整理“这一次要发给模型的材料”。例如一份工具日志特别长，会把原文另存为文件，只在输入里留下预览；很早的完整操作过程可以压缩成摘要，近期内容则尽量保留。

它不会因为压缩历史就修改你的源代码。它处理的是模型输入和相关记录。

## 对应文件和目录

下表路径都相对于项目根目录。`services/agent/src/bit_agent/context/` 是源码目录，`artifacts/context/` 是运行产物目录；它们虽然都以 `context` 命名，但不是同一个文件夹。

| 位置 | 用途 |
| --- | --- |
| `services/agent/src/bit_agent/context/manager.py` | 决定什么时候压缩、保留什么。 |
| `services/agent/src/bit_agent/context/models.py` | 定义输入预算、摘要和外置内容引用等数据结构。 |
| `services/agent/src/bit_agent/context/summarizer.py` | 实现摘要生成、合并和长度控制。 |
| `services/agent/src/bit_agent/context/artifacts.py` | 实现把过大的工具结果保存为文件的功能。 |
| `artifacts/context/` | 运行时保存外置工具结果的产物目录，不是 Python 源码文件。 |

上述源码目录 `services/agent/src/bit_agent/context/` 中，还包含 RepoMap、AST 索引、代码检索和片段提取等功能的实现代码。它们负责从项目源码中“找到有用材料”；Context Manager 负责“把材料控制在本轮能使用的范围”。

另一个目录 `artifacts/context/` 存放的是工具结果外置后保存的实际内容，例如测试日志。它不存放上述检索功能的实现代码，也不是这些功能专门检索的对象。

下面的默认参数来自当前配置模型，不表示已测量出当前所选模型的实际上下文上限。更换模型时，需要让预算与实际服务能力相符。

Context Manager 控制一次 Agent 运行中实际发送给模型的历史。它与 Memory 分工明确：

- Working Memory 保存当前任务的可信状态。
- Long-term Memory 保存跨任务、经过独立验证的经验。
- Context Manager 控制本轮 Prompt 的大小和内容。

```text
完整运行历史
→ Token 估算（包括 Tool Schema）
→ 大型工具结果外置
→ 超过 soft limit 时选择较早的完整事件组
→ LLM 生成结构化 ContextSummary
→ 用当前工作记忆校准摘要中的任务目标和未解决错误，并补充其他任务记录。
→ 保留最近事件后继续调用模型
```

## 协议边界

一次 `function_call` 与对应的 `function_call_output` 是不可拆分单元。Context Manager
只会同时保留或同时压缩它们；尚未得到结果的调用永远保留。System、Developer、最初的
用户目标以及最近事件也受到保护。

LLM 只负责摘要文本。当前目标、已读文件、已修改文件、测试状态和未解决错误以
`WorkingMemory` 为准。超过摘要输入预算的历史会分段处理，并逐段合并摘要，全部成功后
才替换原历史。摘要模型失败、返回非 JSON 或违反 Schema 时，保留原历史并在
`AgentRunResult.context_warnings` 中记录原因；未超硬上限时可继续运行并在后续重试，
超过硬上限时明确停止，避免用缺失信息的摘要覆盖原记录。显式注入的确定性摘要器仍可使用。

## Artifact

超过 `CONTEXT_ARTIFACT_TRIGGER_TOKENS` 的工具结果不再整段重复发送给模型。原文默认保存到：

```text
artifacts/context/<run_id>/
```

输入中保留首尾预览、原始 Token 数、SHA-256 和 Artifact 路径。工具轨迹中的原始
`ToolCallRecord` 不会被修改；模型需要完整内容时应重新调用原工具。

## 配置

```ini
CONTEXT_WINDOW_TOKENS=128000
CONTEXT_RESERVED_OUTPUT_TOKENS=8000
CONTEXT_TARGET_RATIO=0.60
CONTEXT_SOFT_LIMIT_RATIO=0.75
CONTEXT_HARD_LIMIT_RATIO=0.90
CONTEXT_RECENT_GROUPS=8
CONTEXT_MINIMUM_RECENT_GROUPS=2
CONTEXT_ARTIFACT_TRIGGER_TOKENS=4000
CONTEXT_INLINE_TOOL_OUTPUT_TOKENS=1200
CONTEXT_SUMMARIZATION_INPUT_TOKENS=24000
CONTEXT_SUMMARY_TOKENS=4000
```

比例针对扣除 `CONTEXT_RESERVED_OUTPUT_TOKENS` 后的可用输入空间。默认达到 75% 时压缩，
目标降到 60%；超过 90% 时允许把近期保护范围从 8 个原子事件组收紧到 2 个。如果关键
内容本身仍超过硬上限，Agent 会明确失败，避免依赖模型端不可预测的头部截断。

## Runtime 接入

`run_agent()` 默认创建 Context Manager，无需调用方额外配置。需要测试或定制时可以注入：

```python
from bit_agent.agent import run_agent
from bit_agent.context import ContextManagementPolicy

result = await run_agent(
    "修复失败测试",
    workspace_root=workspace,
    context_policy=ContextManagementPolicy(
        context_window_tokens=64_000,
        reserved_output_tokens=4_000,
    ),
)

print(result.context_compactions)
print(result.context_peak_input_tokens)
print(result.context_artifact_paths)
print(result.context_warnings)
```

摘要只保存在上下文历史中的摘要消息里，不再写入 `WorkingMemory.history_summary`。
本地桌面版把这份历史存入 SQLite 的 `context_state` 表。重新打开同一会话时，
`ContextManager.restore_summary()` 从历史里的摘要消息取回摘要；任务目标和进度则另从
`working_memory` 表读取。两份数据分开保存，但在同一次数据库事务里一起落盘。

上下文管理器仍可读取 Working Memory 来校准摘要，例如避免把已解决错误写回来。
这是“读取当前任务事实”，不是把摘要交给 Working Memory 管理。长期记忆的独立验证规则不变。

## 当前策略

这是 Provider 无关的客户端压缩实现，适用于不保存 `previous_response_id` 的中转站。
未来可以增加 OpenAI/Anthropic 原生 Compaction 后端，但工具结果外置、Working Memory
纠偏、协议完整性检查和硬上限仍由 Harness 保留。
> 2026-09-09 验收更新：本地运行链路已通过回归和真实 Electron 串联检查。文中早先的“未验收”描述是修改阶段的记录；最新结果及未覆盖范围见 [本地版验收报告](ACCEPTANCE_LOCAL_RUNTIME.md)。
