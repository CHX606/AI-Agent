"""真实 Redis 与 PostgreSQL + pgvector 后端的可选集成测试。"""

import asyncio
import os
import sys
from collections.abc import Sequence
from uuid import uuid4

import pytest
from bit_agent.memory import (
    ConsolidationStatus,
    LLMMemoryCandidateExtractor,
    MemoryCandidate,
    MemoryConsolidator,
    MemoryDisposition,
    MemoryKind,
    MemoryRetriever,
    MemoryScope,
    PostgreSQLLongTermMemoryStore,
    RedisWorkingMemoryStore,
    VerifiedRunEvidence,
    WorkingMemory,
)
from bit_agent.memory import TestStatus as MemoryTestStatus

REDIS_URL = os.getenv("BIT_AGENT_TEST_REDIS_URL")
POSTGRES_DSN = os.getenv("BIT_AGENT_TEST_POSTGRES_DSN")
RUN_LLM_TEST = os.getenv("BIT_AGENT_TEST_LLM") == "1"


class StaticExtractor:
    """让后端测试不依赖模型输出的随机性。"""

    def __init__(self, candidate: MemoryCandidate) -> None:
        self.candidate = candidate

    async def extract(self, evidence: VerifiedRunEvidence) -> list[MemoryCandidate]:
        assert evidence.independently_verified
        return [self.candidate]


class StaticEmbedding:
    """提供稳定向量，只验证 pgvector 的保存和召回链路。"""

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[1.0, 0.5, -0.25] for _ in texts]


@pytest.mark.skipif(not REDIS_URL, reason="未配置真实 Redis 集成测试地址")
@pytest.mark.asyncio
async def test_redis_working_memory_survives_a_new_python_process() -> None:
    thread_id = f"memory-e2e-{uuid4().hex}"
    writer = RedisWorkingMemoryStore.from_url(REDIS_URL, default_ttl_seconds=120)
    memory = WorkingMemory(
        thread_id=thread_id,
        objective="验证 Working Memory 可以跨进程恢复",
        files_read=["calculator.py"],
        important_findings=["add 函数曾错误地执行减法"],
        latest_test_status=MemoryTestStatus.PASSED,
        rounds=5,
    )

    await writer.save(memory)
    child_code = """
import asyncio
import os
import sys
from bit_agent.memory import RedisWorkingMemoryStore

async def main():
    store = RedisWorkingMemoryStore.from_url(os.environ["BIT_AGENT_TEST_REDIS_URL"])
    memory = await store.load(os.environ["BIT_AGENT_TEST_THREAD_ID"])
    payload = memory.model_dump_json() if memory is not None else "null"
    sys.stdout.buffer.write(payload.encode("utf-8"))
    await store.client.aclose()

asyncio.run(main())
"""
    child_environment = os.environ.copy()
    child_environment["BIT_AGENT_TEST_THREAD_ID"] = thread_id
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        child_code,
        env=child_environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()

    try:
        assert process.returncode == 0, stderr.decode("utf-8", errors="replace")
        restored = WorkingMemory.model_validate_json(stdout)
        assert restored == memory
        ttl = await writer.client.ttl(f"bit-agent:working-memory:{thread_id}")
        assert 0 < ttl <= 120
    finally:
        await writer.delete(thread_id)
        await writer.client.aclose()


@pytest.mark.skipif(not POSTGRES_DSN, reason="未配置真实 PostgreSQL 集成测试地址")
@pytest.mark.asyncio
async def test_postgres_memory_is_saved_reconnected_and_vector_retrieved() -> None:
    table_name = f"bit_agent_memories_e2e_{uuid4().hex[:12]}"
    memory_key = "project.testing.docker_required"
    first_connection = PostgreSQLLongTermMemoryStore(
        POSTGRES_DSN,
        table_name=table_name,
    )
    await first_connection.initialize()

    candidate = MemoryCandidate(
        scope=MemoryScope.PROJECT,
        kind=MemoryKind.PROCEDURE,
        memory_key=memory_key,
        title="代码修改后必须在 Docker 中验证",
        content="Bit Agent 修改代码后必须在 DockerSandbox 中运行测试，测试成功后才能结束任务。",
        applicability="Bit Agent 项目中的代码修改任务",
        evidence_summary="独立 Docker pytest 验证已通过。",
        tags=["docker", "testing"],
        importance=0.9,
        confidence=1.0,
    )
    working_memory = WorkingMemory(
        thread_id="memory-postgres-e2e",
        objective="验证长期记忆真实持久化",
        changed_files=["calculator.py"],
        latest_test_status=MemoryTestStatus.PASSED,
    )
    evidence = VerifiedRunEvidence(
        run_id=f"run-{uuid4().hex}",
        thread_id=working_memory.thread_id,
        project_id="bit-agent-memory-e2e",
        objective=working_memory.objective,
        working_memory=working_memory,
        final_answer="修复已经完成并通过测试。",
        changed_files=["calculator.py"],
        verification_summary="4 passed",
        independently_verified=True,
    )
    consolidator = MemoryConsolidator(
        StaticExtractor(candidate),
        first_connection,
        embedding_provider=StaticEmbedding(),
    )

    result = await consolidator.consolidate(evidence)

    assert result.status is ConsolidationStatus.COMPLETED
    assert result.reviews[0].disposition is MemoryDisposition.ACCEPTED
    assert len(result.created) == 1

    second_connection = PostgreSQLLongTermMemoryStore(
        POSTGRES_DSN,
        table_name=table_name,
    )
    restored = await second_connection.find_by_key(
        scope=MemoryScope.PROJECT,
        memory_key=memory_key,
        project_id="bit-agent-memory-e2e",
        user_id=None,
    )
    matches = await second_connection.search(
        [1.0, 0.5, -0.25],
        project_id="bit-agent-memory-e2e",
        limit=5,
    )
    hybrid_matches = await MemoryRetriever(
        second_connection,
        StaticEmbedding(),
    ).retrieve("Docker 测试", project_id="bit-agent-memory-e2e")

    assert restored is not None
    assert restored.id == result.created[0].id
    assert restored.content == candidate.content
    assert restored.embedding == [1.0, 0.5, -0.25]
    assert restored.embedding_profile is not None
    assert restored.source_references
    assert len(matches) == 1
    assert matches[0].memory.id == restored.id
    assert matches[0].similarity == pytest.approx(1.0)
    assert hybrid_matches[0].memory.id == restored.id


@pytest.mark.skipif(
    not POSTGRES_DSN or not RUN_LLM_TEST,
    reason="未启用真实 LLM + PostgreSQL 记忆巩固测试",
)
@pytest.mark.asyncio
async def test_real_llm_consolidates_verified_evidence_into_postgres() -> None:
    from bit_agent.llm.client import client, model_name

    table_name = f"bit_agent_memories_llm_e2e_{uuid4().hex[:12]}"
    store = PostgreSQLLongTermMemoryStore(POSTGRES_DSN, table_name=table_name)
    await store.initialize()
    working_memory = WorkingMemory(
        thread_id="memory-llm-e2e",
        objective="验证 Bit Agent 的长期记忆巩固流程",
        changed_files=["services/agent/src/bit_agent/memory/postgres.py"],
        important_findings=[
            "Bit Agent 的代码修改任务必须通过 DockerSandbox 测试后才能完成。",
            "独立评测器会拒绝测试失败或修改了不允许路径的运行结果。",
        ],
        latest_test_status=MemoryTestStatus.PASSED,
        rounds=6,
    )
    evidence = VerifiedRunEvidence(
        run_id=f"run-llm-{uuid4().hex}",
        thread_id=working_memory.thread_id,
        project_id="bit-agent-memory-llm-e2e",
        objective=working_memory.objective,
        working_memory=working_memory,
        final_answer="记忆框架已完成，并通过真实 Redis 和 PostgreSQL 集成测试。",
        changed_files=working_memory.changed_files,
        tool_trace_summary="修改 PostgreSQL 适配器，然后在 Docker 中运行集成测试。",
        diff="PostgreSQL 数据库操作使用工作线程，保持上层异步接口。",
        verification_summary="真实 Redis 跨进程恢复通过；PostgreSQL 重连和 pgvector 召回通过。",
        independently_verified=True,
    )
    consolidator = MemoryConsolidator(
        LLMMemoryCandidateExtractor(client, model_name),
        store,
        embedding_provider=StaticEmbedding(),
    )

    result = await consolidator.consolidate(evidence)

    assert result.status is ConsolidationStatus.COMPLETED, result.error
    assert result.created, "真实 LLM 没有从明确、已验证的项目规则中提炼出可写入候选"
    reconnected_store = PostgreSQLLongTermMemoryStore(
        POSTGRES_DSN,
        table_name=table_name,
    )
    for created in result.created:
        restored = await reconnected_store.find_by_key(
            scope=created.scope,
            memory_key=created.memory_key,
            project_id=created.project_id,
            user_id=created.user_id,
        )
        assert restored is not None
        assert restored.id == created.id

    print(result.model_dump_json(indent=2))
