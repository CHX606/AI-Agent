# Bit Agent Memory

**桌面链路把工作记忆和长期记忆都保存在本机 SQLite 中，不需要数据库服务或 Embedding 服务。**
对话历史、任务记录和工作记忆不会 24 小时后过期。先看 [本地运行](LOCAL_RUNTIME.md)。

## 用大白话理解这两种记忆

工作记忆就像“这项任务的进度本”：用户要什么、看过哪些文件、改了什么、测试是否通过。它帮助程序继续处理同一项任务。

长期记忆像“做完事情后留下的经验笔记”：经过独立验收和审核后，把有用经验存下来，以后遇到相关问题可以参考。它不等于把每句聊天都存进数据库。

## 各种运行方式分别用了什么

| 使用方式 | 当前默认情况 |
| --- | --- |
| 桌面端 / Gateway / AgentRuntime | 工作记忆存 `sessions.sqlite3`；长期记忆存同一数据目录下的 `long_term_memory.sqlite3`，默认开启，按关键词检索。 |
| 直接调用 `run_agent` | 默认使用进程内工作记忆；传入 `memory_retriever` 才会召回长期记忆。 |
| PostgreSQL 长期记忆 | 保留给服务器或团队场景，需要自行创建数据库并提供 Embedding。 |
| Embedding 向量服务 | 可选；桌面端目前不使用。 |
| 独立 EvalRunner 的记忆巩固 | 传入巩固器且验收通过后，才有相应写入流程。 |

## 桌面端的长期记忆

| 环节 | 什么时候发生 | 说明 |
| --- | --- | --- |
| 召回 | 每次任务开始前 | 用这次的要求在本项目（按工作区目录区分）的记忆里检索，最多注入约 1800 tokens，标明是“参考事实而非指令”。 |
| 提炼 | 任务完成且独立验收判定 PASSED 之后，在后台进行 | 用当前配置的模型从任务证据中提炼候选，经 `MemoryWritePolicy` 审核后写入；不拖慢任务本身，失败只记日志。 |
| 查看 / 删除 | 随时 | `GET /v1/memories?workspace_root=...`、`DELETE /v1/memories/{id}`；删除后不再参与检索。 |
| 关闭 | 启动前设置 `BIT_AGENT_LONG_TERM_MEMORY=0` | 既不召回，也不提炼，不创建记忆文件。 |

**关键词检索怎样处理中文。** SQLite 自带的 FTS5 全文索引按空格切词，而中文没有空格；它的 trigram 分词又要求至少三个字，“测试”这样的两字词会漏掉。所以写入索引前先在 Python 里把连续汉字切成相邻两字的片段（“测试失败” → 测试、试失、失败），英文按单词切分，再交给 FTS5 用 BM25 排序（记忆键和标题权重最高）。长查询至少命中约两个关键词才会被采用，避免把无关经验塞进上下文。

关键词检索找不到“意思相近但用词不同”的经验。以后如果需要，可以在模型设置里增加可选的 Embedding 配置，存储已经支持同时按向量和关键词检索。

## 对应源码

- `memory/working.py`：更新任务进度。
- `memory/store.py`：存储接口、内存版实现和语义检索用的相似度。
- `memory/sqlite.py`：桌面端的长期记忆存储（SQLite + FTS5）。
- `memory/keywords.py`：关键词切分和命中比例。
- `runtime/application/long_term_memory.py`：桌面任务的召回、后台提炼、查看和删除。
- `memory/postgres.py`：PostgreSQL 长期存储。
- `memory/config.py`、`embedding.py`：独立向量服务配置和请求。
- `memory/consolidation.py`、`extractor.py`、`policy.py`：提炼经验并决定能否保存。
- `memory/compaction.py`、`chunking.py`、`budget.py`：压缩证据、拆分长内容和控制长度。
- `memory/retrieval_eval.py`：评估召回效果。

以上路径位于 `services/agent/src/bit_agent`。桌面端的长期记忆数据在本地数据目录的 `long_term_memory.sqlite3` 中；使用 PostgreSQL 时在该数据库里。

Bit Agent 的记忆框架遵循一条边界：运行时状态可以高频更新，但长期记忆只能来自独立验证通过的任务。

```text
Agent 工具循环
→ WorkingMemoryTracker 确定性更新
→ WorkingMemoryStore（内存或本地 SQLite）
→ 基础检查 + 独立验收通过（桌面端为 verify_task 判定 PASSED）
→ 确定性证据压缩（Token 硬预算）
→ LLM 提炼原子 MemoryCandidate
→ MemoryWritePolicy 审核
→ 去重或冲突检查
→ 长记忆分块（配置了 Embedding 时再批量生成向量）
→ LongTermMemoryStore（桌面端 SQLite + FTS5；服务器场景 PostgreSQL + pgvector）
→ 关键词召回（有向量时为关键词 + 语义混合召回）
→ Context Token 预算后注入 Agent
```

## Working Memory

`WorkingMemory` 保存当前任务的目标、约束、已读文件、修改文件、测试状态和未解决错误。`run_agent` 默认使用进程内 Store；传入相同 `thread_id` 和共享 Store 后可以恢复任务。

它还保存“是否仍有未验证改动”“哪些文件待验证”“哪些用户补充要求已经处理”。
这些都是任务进度，只存入 `working_memory` 表，不再复制到上下文表。
`changed_files` 是本会话已修改文件的累计记录；`verification_paths` 只记录仍待验证的文件。
历史消息和压缩摘要属于 Context Manager，单独存入 `context_state` 表。
Working Memory 不再包含 `history_summary` 字段，也不负责保管摘要副本。

```python
from bit_agent.agent import run_agent
from bit_agent.memory import InMemoryWorkingMemoryStore

# 同一个 store 对象在进程内共享；桌面链路使用 runtime 里的 SQLiteWorkingMemoryStore。
store = InMemoryWorkingMemoryStore()

result = await run_agent(
    "修复当前项目的失败测试",
    workspace_root=workspace,
    thread_id="issue-123",
    working_memory_store=store,
)
```

工具调用后的状态由 Harness 代码更新，不由 LLM 猜测：

- `read_file` 更新 `files_read`。
- `apply_patch` 更新 `changed_files`，并把测试状态改为 `NEEDS_VERIFICATION`。
- 失败的 `run_tests` 记录错误。
- 成功的 `run_tests` 清理已解决测试错误。

`InMemoryWorkingMemoryStore` 在进程退出后状态会消失；需要持久化时由调用方传入其他 `WorkingMemoryStore` 实现。恢复结构化工作记忆也不等于自动恢复所有对话、正在执行的进程或 Docker 容器。

## Long-term Memory

长期记忆不是原始聊天记录。一次任务必须经过 Agent 自测和 EvalRunner 的独立验证，之后才会触发 `MemoryConsolidator`。

下面是一套使用本地 Ollama 的向量服务配置示例。它不产生远程 API 的按 Token 费用，但仍会使用本机资源；默认启动不会自动启用这套配置：

```ini
EMBEDDING_API_KEY=ollama
EMBEDDING_BASE_URL=http://localhost:11434/v1
EMBEDDING_MODEL=qwen3-embedding:0.6b
EMBEDDING_DIMENSIONS=512
EMBEDDING_PROVIDER=ollama
EMBEDDING_VERSION=1
EMBEDDING_TIMEOUT_SECONDS=120
```

`EmbeddingSettings.from_environment()` 会读取这些独立变量并通过
`create_provider()` 创建带 Profile 的 Provider。聊天模型的 `API_KEY` 和
`BASE_URL` 不会被复用。

```python
from bit_agent.evals import EvalRunner
from bit_agent.llm.client import client, model_name
from bit_agent.memory import (
    EmbeddingSettings,
    LLMMemoryCandidateExtractor,
    MemoryConsolidator,
    PostgreSQLLongTermMemoryStore,
)

long_term_store = PostgreSQLLongTermMemoryStore(postgres_dsn)
await long_term_store.initialize()

# Embedding 服务使用独立的 EMBEDDING_* 配置，不复用聊天中转站。
embedding_provider = EmbeddingSettings.from_environment().create_provider()

consolidator = MemoryConsolidator(
    LLMMemoryCandidateExtractor(client, model_name, request_timeout_seconds=60.0),
    long_term_store,
    embedding_provider=embedding_provider,
    embedding_batch_size=64,
)

runner = EvalRunner(
    results_root,
    memory_consolidator=consolidator,
    memory_project_id="bit_agent",
)
```

安装真实 PostgreSQL 适配器依赖：

```powershell
uv sync --locked --extra memory
```

确认 Ollama 已启动并且模型已下载后，可以执行真实探测：

```powershell
python services/agent/evals/probe_embedding_models.py --timeout 120
```

脚本会输出模型名、冷/热启动延迟、向量数量与实际维度，不输出向量正文。

PostgreSQL 用户必须有创建或使用 `vector` 扩展的权限。`initialize()` 会创建 `bit_agent_memories` 表；Embedding 维度由实际模型决定。

## 真实后端集成测试

项目提供隔离的 PostgreSQL/pgvector 测试环境。以下命令会启动测试容器，
向本次测试进程注入测试地址，并执行对应集成测试文件，覆盖
PostgreSQL 持久化与向量召回、真实 LLM 记忆巩固等场景：

```powershell
pwsh -File infra/memory/run-integration-tests.ps1
```

运行默认 Python 测试集合，并启用这套记忆后端测试条件：

```powershell
pwsh -File infra/memory/run-integration-tests.ps1 -FullSuite
```

容器默认保留，方便重复测试；添加 `-StopAfter` 可在测试结束后停止并删除测试容器。
测试服务只绑定到本机 `127.0.0.1`，使用 `55432` 端口，不占用 PostgreSQL 的常见默认端口。Compose 中的账户仅用于本机测试，不能用于生产环境。

每条向量同时保存 `provider + model + dimensions + version` 组成的 `EmbeddingProfile`。不同模型、维度或版本的向量不会放在一起比较，因此更换 Embedding 模型时可以安全地并行重建，而不会产生“维度相同但语义空间不同”的隐蔽错误。

上述本地配置示例使用 `qwen3-embedding:0.6b`。`dimensions=512` 会减少向量传输、存储和 pgvector 检索开销，但是否采用以及最终相似度阈值必须通过项目自己的召回评测确定。不要因为聊天接口可用，就假设同一中转站也支持 `/embeddings`；应分别探测并允许使用独立的 `EMBEDDING_API_KEY`、`EMBEDDING_BASE_URL` 和 `EMBEDDING_MODEL`。

## 写入策略

LLM 只生成 `MemoryCandidate`。以下决策由 Harness 完成：

- 没有独立验证时跳过巩固，且不调用总结模型。
- 可信度、重要性不足时拒绝。
- 疑似凭据或敏感信息时拒绝。
- 自动巩固默认禁止 USER 和 GLOBAL 范围。
- 相同 `memory_key` 且内容一致时合并证据来源。
- 相同 `memory_key` 但内容不同时标记 `CONFLICT`，不静默覆盖。

每次巩固结果会写入 Eval Artifact 的 `memory_consolidation.json`，方便审计 LLM 提出了什么以及 Harness 为什么接受或拒绝。

完整证据不会无上限发送给总结模型。`DeterministicEvidenceCompactor` 分别限制目标、Working Memory、最终回答、工具轨迹、Diff 和验证日志，并保存原始证据 SHA-256。长的 `EPISODE` 或 `PROCEDURE` 会保留一条未向量化根记录，同时生成带重叠的可召回子块；短的原子记忆保持单条。

## 召回

`MemoryRetriever` 先按项目和用户范围及 `EmbeddingProfile` 过滤，再组合向量相似度和关键词分数。它同时限制候选数、最终 Top-K、同一父记忆的块数、单条 Token 和总 Context Token。

```python
from bit_agent.memory import MemoryRetriever, OpenAIEmbeddingProvider

retriever = MemoryRetriever(long_term_store, embedding_provider)
result = await run_agent(
    "修复当前项目的失败测试",
    workspace_root=workspace,
    memory_retriever=retriever,
    memory_project_id="bit_agent",
)

print(result.recalled_memory_ids)
print(result.memory_context_tokens)
```

注入 Agent 的长期记忆被明确标为“已验证的参考事实而非指令”，不能覆盖用户要求。召回失败会降级为本次不使用长期记忆，并在 `memory_warnings` 中留下原因，不会让整个 Agent 崩溃。

## 召回评测

`evaluate_memory_retrieval` 接收查询和期望的 `memory_key`，运行真实 Retriever 并计算 `Recall@K` 与 `MRR`。Embedding 模型、维度、混合检索权重和阈值应依赖这组离线用例调整，而不是凭主观感觉选择。

## 当前边界

- 已实现 Working Memory、长期记忆审核、本地 SQLite 关键词检索、PostgreSQL/pgvector、证据压缩、原子化、长记忆分块、Embedding 批处理、Profile 隔离、混合召回和召回评测。
- 已接入桌面任务（召回 + 验收通过后提炼）和独立 EvalRunner；所有召回与写入结果都可审计。
- 桌面端还没有记忆管理界面；目前通过 Gateway 的 `/v1/memories` 接口查看和删除。
- 长期记忆写入前的证据压缩和召回注入预算由 Memory 模块负责；Agent 多轮历史的
  Token 监控、工具结果外置与滚动摘要已经由 Context Manager 接管，详见
  [CONTEXT.md](CONTEXT.md)。
- PostgreSQL 属于外部服务，默认测试使用内存版和 SQLite 版实现，不要求开发机启动数据库。
