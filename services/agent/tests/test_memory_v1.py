"""Memory V1 的预算、分块、批处理、混合召回和离线评测。"""

from collections.abc import Sequence

import pytest
from bit_agent.memory import (
    DeterministicEvidenceCompactor,
    EmbeddingProfile,
    EvidenceCompactionPolicy,
    InMemoryLongTermMemoryStore,
    MemoryCandidate,
    MemoryChunkingPolicy,
    MemoryConsolidator,
    MemoryKind,
    MemoryRecord,
    MemoryRetrievalCase,
    MemoryRetrievalPolicy,
    MemoryRetriever,
    MemoryScope,
    VerifiedRunEvidence,
    WorkingMemory,
    estimate_tokens,
    evaluate_memory_retrieval,
    split_text_by_token_budget,
    truncate_to_token_budget,
)


def make_candidate(
    memory_key: str,
    content: str,
    *,
    title: str | None = None,
) -> MemoryCandidate:
    return MemoryCandidate(
        scope=MemoryScope.PROJECT,
        kind=MemoryKind.PROCEDURE,
        memory_key=memory_key,
        title=title or memory_key,
        content=content,
        applicability="Bit Agent 项目",
        evidence_summary="独立验证已经通过。",
        tags=memory_key.split("."),
        importance=0.9,
        confidence=1.0,
    )


def make_evidence() -> VerifiedRunEvidence:
    working = WorkingMemory(
        thread_id="thread-v1",
        objective="验证生产形态记忆框架",
    )
    return VerifiedRunEvidence(
        run_id="run-v1",
        thread_id=working.thread_id,
        project_id="bit_agent",
        objective=working.objective,
        working_memory=working,
        final_answer="任务完成。" * 1_000,
        tool_trace_summary="调用工具并检查结果。" * 1_000,
        diff="- old\n+ new\n" * 2_000,
        verification_summary="全部测试通过。" * 1_000,
        independently_verified=True,
    )


class StaticExtractor:
    def __init__(self, candidates: list[MemoryCandidate]) -> None:
        self.candidates = candidates

    async def extract(self, evidence: VerifiedRunEvidence) -> list[MemoryCandidate]:
        assert evidence.independently_verified
        return self.candidates


class RecordingEmbedding:
    def __init__(self, *, model: str = "memory-test") -> None:
        self.model = model
        self.batches: list[list[str]] = []

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        self.batches.append(list(texts))
        return [[1.0, 0.0, 0.5] for _ in texts]

    def profile_for_dimensions(self, dimensions: int) -> EmbeddingProfile:
        return EmbeddingProfile(
            provider="test",
            model=self.model,
            dimensions=dimensions,
        )


def test_token_budget_is_a_hard_upper_bound() -> None:
    text = "中文内容 mixed ASCII words and symbols! " * 100

    for budget in (1, 2, 10, 80):
        bounded = truncate_to_token_budget(text, budget)
        assert estimate_tokens(bounded) <= budget

    chunks = split_text_by_token_budget(text, max_tokens=50, overlap_tokens=5)
    assert len(chunks) > 1
    assert all(estimate_tokens(chunk) <= 50 for chunk in chunks)


def test_evidence_compaction_preserves_hash_and_total_budget() -> None:
    compacted = DeterministicEvidenceCompactor(
        EvidenceCompactionPolicy(
            objective_tokens=50,
            working_memory_tokens=50,
            final_answer_tokens=50,
            tool_trace_tokens=50,
            diff_tokens=50,
            verification_tokens=50,
            max_total_tokens=100,
        )
    ).compact(make_evidence())

    assert compacted.original_characters > compacted.compacted_characters
    assert compacted.estimated_tokens <= 100
    assert len(compacted.evidence_hash) == 64


@pytest.mark.asyncio
async def test_many_atomic_memories_are_embedded_in_batches() -> None:
    candidates = [
        make_candidate(
            f"project.rule.item_{index}",
            f"规则内容 {index}：代码修改以后必须完成独立验证才能结束任务。",
        )
        for index in range(7)
    ]
    provider = RecordingEmbedding()
    store = InMemoryLongTermMemoryStore()
    consolidator = MemoryConsolidator(
        StaticExtractor(candidates),
        store,
        embedding_provider=provider,
        embedding_batch_size=3,
    )

    result = await consolidator.consolidate(make_evidence())

    assert len(result.created) == 7
    assert [len(batch) for batch in provider.batches] == [3, 3, 1]
    assert all(memory.embedding_profile is not None for memory in result.created)


@pytest.mark.asyncio
async def test_long_memory_has_unembedded_root_and_retrievable_chunks() -> None:
    content = "\n\n".join(f"第 {index} 段经验：" + "边界验证" * 40 for index in range(20))
    provider = RecordingEmbedding()
    store = InMemoryLongTermMemoryStore()
    consolidator = MemoryConsolidator(
        StaticExtractor([make_candidate("project.long.procedure", content)]),
        store,
        embedding_provider=provider,
        chunking_policy=MemoryChunkingPolicy(
            chunk_threshold_tokens=100,
            max_chunk_tokens=70,
            overlap_tokens=10,
        ),
    )

    result = await consolidator.consolidate(make_evidence())
    root = next(memory for memory in result.created if memory.parent_memory_id is None)
    children = [memory for memory in result.created if memory.parent_memory_id == root.id]

    assert root.embedding is None
    assert root.chunk_count == len(children)
    assert children
    assert all(child.embedding is not None for child in children)
    assert all(estimate_tokens(child.content) <= 70 for child in children)
    assert all(child.content_hash for child in children)


@pytest.mark.asyncio
async def test_embedding_profile_isolation_and_lexical_reranking() -> None:
    profile_a = EmbeddingProfile(provider="test", model="a", dimensions=3)
    store = InMemoryLongTermMemoryStore()
    docker = MemoryRecord.from_candidate(
        make_candidate("project.testing.docker", "使用 Docker 执行测试"),
        source_run_id="run-a",
        project_id="bit_agent",
        user_id=None,
        embedding=[1.0, 0.0, 0.5],
        embedding_profile=profile_a,
    )
    redis = MemoryRecord.from_candidate(
        make_candidate("project.memory.redis", "Redis 保存短期 Working Memory"),
        source_run_id="run-a",
        project_id="bit_agent",
        user_id=None,
        embedding=[1.0, 0.0, 0.5],
        embedding_profile=profile_a,
    )
    await store.save_many([docker, redis])

    matching_retriever = MemoryRetriever(
        store,
        RecordingEmbedding(model="a"),
        policy=MemoryRetrievalPolicy(
            minimum_similarity=-1.0,
            semantic_weight=0.2,
            lexical_weight=0.8,
        ),
    )
    matches = await matching_retriever.retrieve("Redis", project_id="bit_agent")
    assert matches[0].memory.id == redis.id
    assert "lexical" in matches[0].matched_by

    mismatched_retriever = MemoryRetriever(
        store,
        RecordingEmbedding(model="b"),
        policy=MemoryRetrievalPolicy(minimum_similarity=-1.0),
    )
    assert await mismatched_retriever.retrieve("Redis", project_id="bit_agent") == []


@pytest.mark.asyncio
async def test_context_budget_and_retrieval_eval_are_machine_checkable() -> None:
    provider = RecordingEmbedding(model="a")
    store = InMemoryLongTermMemoryStore()
    consolidator = MemoryConsolidator(
        StaticExtractor(
            [
                make_candidate(
                    "project.memory.redis",
                    "Redis Working Memory " * 100,
                    title="Redis 记忆",
                )
            ]
        ),
        store,
        embedding_provider=provider,
    )
    await consolidator.consolidate(make_evidence())
    retriever = MemoryRetriever(
        store,
        provider,
        policy=MemoryRetrievalPolicy(
            minimum_similarity=-1.0,
            max_context_tokens=80,
            max_memory_tokens=60,
        ),
    )

    context = await retriever.build_context("Redis", project_id="bit_agent")
    evaluation = await evaluate_memory_retrieval(
        retriever,
        [
            MemoryRetrievalCase(
                name="redis-working-memory",
                query="Redis",
                expected_memory_keys=["project.memory.redis"],
                project_id="bit_agent",
            )
        ],
    )

    assert context.estimated_tokens <= 80
    assert context.truncated is True
    assert evaluation.recall_at_k == 1.0
    assert evaluation.mean_reciprocal_rank == 1.0
