"""Working Memory、长期记忆巩固与召回的单元测试。"""

from collections.abc import Sequence
from pathlib import Path
from types import SimpleNamespace

import pytest
from bit_agent.agent.result import AgentRunStatus, ToolCallRecord
from bit_agent.evals import EvalCase, EvalRunner
from bit_agent.memory import (
    ConsolidationStatus,
    InMemoryLongTermMemoryStore,
    LLMMemoryCandidateExtractor,
    MemoryCandidate,
    MemoryConsolidator,
    MemoryDisposition,
    MemoryKind,
    MemoryRetriever,
    MemoryScope,
    OpenAIEmbeddingProvider,
    RedisWorkingMemoryStore,
    VerifiedRunEvidence,
    WorkingMemory,
    WorkingMemoryTracker,
)
from bit_agent.memory import TestStatus as MemoryTestStatus
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolError, ToolMetadata, ToolResult, ToolStatus


def tool_record(
    name: str,
    *,
    arguments: dict[str, object] | None = None,
    status: ToolStatus = ToolStatus.SUCCESS,
    affected_paths: list[str] | None = None,
) -> ToolCallRecord:
    import json

    result = ToolResult(
        tool_call_id=f"call-{name}",
        tool_name=name,
        status=status,
        output="ok" if status is ToolStatus.SUCCESS else None,
        error=None
        if status is ToolStatus.SUCCESS
        else ToolError(code="FAILED", message="工具失败", retryable=True),
        metadata=ToolMetadata(duration_ms=1, affected_paths=affected_paths or []),
    )
    return ToolCallRecord.from_tool_result(
        round_number=1,
        raw_arguments=json.dumps(arguments or {}),
        result=result,
    )


def candidate(
    *,
    content: str = "Bit Agent 修改代码后必须通过 DockerSandbox 运行测试。",
    memory_key: str = "project.testing.docker_required",
) -> MemoryCandidate:
    return MemoryCandidate(
        scope=MemoryScope.PROJECT,
        kind=MemoryKind.FACT,
        memory_key=memory_key,
        title="代码修改需要 Docker 测试",
        content=content,
        applicability="Bit Agent 的代码修改任务",
        evidence_summary="独立 Docker pytest 验证已经成功通过。",
        tags=["docker", "testing"],
        importance=0.8,
        confidence=1.0,
    )


def evidence(run_id: str = "run-1", *, verified: bool = True) -> VerifiedRunEvidence:
    memory = WorkingMemory(
        thread_id="thread-1",
        objective="修复功能错误",
        changed_files=["calculator.py"],
        latest_test_status=MemoryTestStatus.PASSED,
    )
    return VerifiedRunEvidence(
        run_id=run_id,
        thread_id="thread-1",
        project_id="bit_agent",
        objective="修复功能错误",
        working_memory=memory,
        final_answer="修复完成",
        changed_files=["calculator.py"],
        verification_summary="4 passed",
        independently_verified=verified,
    )


class StaticExtractor:
    def __init__(self, candidates: list[MemoryCandidate]) -> None:
        self.candidates = candidates
        self.calls = 0

    async def extract(self, run_evidence: VerifiedRunEvidence) -> list[MemoryCandidate]:
        assert run_evidence.independently_verified
        self.calls += 1
        return self.candidates


class StaticEmbedding:
    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[1.0, float(index + 1)] for index, _ in enumerate(texts)]


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.expirations: dict[str, int] = {}

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def set(self, key: str, value: str, *, ex: int) -> None:
        self.values[key] = value
        self.expirations[key] = ex

    async def delete(self, key: str) -> None:
        self.values.pop(key, None)


def test_working_memory_is_updated_by_deterministic_tool_results() -> None:
    tracker = WorkingMemoryTracker.create("修复错误", thread_id="thread-1")

    tracker.record_tool_call(tool_record("read_file", arguments={"path": "calculator.py"}))
    tracker.record_tool_call(tool_record("apply_patch", affected_paths=["calculator.py"]))

    assert tracker.memory.files_read == ["calculator.py"]
    assert tracker.memory.changed_files == ["calculator.py"]
    assert tracker.memory.latest_test_status is MemoryTestStatus.NEEDS_VERIFICATION

    tracker.record_tool_call(tool_record("run_tests", status=ToolStatus.ERROR))
    assert tracker.memory.latest_test_status is MemoryTestStatus.FAILED
    assert tracker.memory.unresolved_errors == ["run_tests: 工具失败"]

    tracker.record_tool_call(tool_record("run_tests"))
    assert tracker.memory.latest_test_status is MemoryTestStatus.PASSED
    assert tracker.memory.unresolved_errors == []


@pytest.mark.asyncio
async def test_redis_working_memory_round_trip_and_ttl() -> None:
    redis = FakeRedis()
    store = RedisWorkingMemoryStore(redis, default_ttl_seconds=60)
    memory = WorkingMemory(thread_id="thread-1", objective="继续任务")

    await store.save(memory)
    restored = await store.load("thread-1")

    assert restored == memory
    assert redis.expirations["bit-agent:working-memory:thread-1"] == 60
    await store.delete("thread-1")
    assert await store.load("thread-1") is None


@pytest.mark.asyncio
async def test_unverified_run_never_calls_llm_or_writes_memory() -> None:
    extractor = StaticExtractor([candidate()])
    store = InMemoryLongTermMemoryStore()
    consolidator = MemoryConsolidator(extractor, store)

    result = await consolidator.consolidate(evidence(verified=False))

    assert result.status is ConsolidationStatus.SKIPPED
    assert extractor.calls == 0
    assert await store.all() == []


@pytest.mark.asyncio
async def test_verified_candidate_is_embedded_and_saved() -> None:
    extractor = StaticExtractor([candidate()])
    store = InMemoryLongTermMemoryStore()
    consolidator = MemoryConsolidator(
        extractor,
        store,
        embedding_provider=StaticEmbedding(),
    )

    result = await consolidator.consolidate(evidence())

    assert result.status is ConsolidationStatus.COMPLETED
    assert result.reviews[0].disposition is MemoryDisposition.ACCEPTED
    assert result.created[0].embedding == [1.0, 1.0]
    assert result.created[0].source_run_ids == ["run-1"]
    assert len(await store.all()) == 1


@pytest.mark.asyncio
async def test_llm_extractor_parses_json_and_normalizes_schema_values() -> None:
    payload = {
        "candidates": [
            {
                "scope": "project",
                "kind": "constraint",
                "memory_key": "Project.Testing.Docker_Required",
                "title": "代码修改需要 Docker 测试",
                "content": "Bit Agent 修改代码后必须通过 DockerSandbox 运行测试。",
                "applicability": "Bit Agent 的代码修改任务",
                "evidence_summary": "独立 Docker pytest 验证已经成功通过。",
                "tags": ["Testing", "Docker"],
                "importance": 4,
                "confidence": 5,
            }
        ]
    }

    class FakeResponses:
        def create(self, **kwargs: object) -> SimpleNamespace:
            assert kwargs["model"] == "memory-model"
            assert kwargs["timeout"] == 60.0
            return SimpleNamespace(output_text=f"```json\n{__import__('json').dumps(payload)}\n```")

    extractor = LLMMemoryCandidateExtractor(
        SimpleNamespace(responses=FakeResponses()),
        "memory-model",
    )

    extracted = await extractor.extract(evidence())

    assert extracted[0].scope is MemoryScope.PROJECT
    assert extracted[0].kind is MemoryKind.PROCEDURE
    assert extracted[0].memory_key == "project.testing.docker_required"
    assert extracted[0].tags == ["docker", "testing"]
    assert extracted[0].importance == 0.8
    assert extracted[0].confidence == 1.0


@pytest.mark.asyncio
async def test_llm_extractor_retries_invalid_schema_once() -> None:
    valid_payload = {
        "candidates": [
            {
                "scope": "PROJECT",
                "kind": "FACT",
                "memory_key": "project.testing.verified",
                "title": "测试已验证",
                "content": "代码修改需要通过测试。",
                "applicability": "代码修改任务",
                "evidence_summary": "独立测试已经通过。",
                "tags": ["testing"],
                "importance": 0.8,
                "confidence": 1.0,
            }
        ]
    }

    class RetryResponses:
        def __init__(self) -> None:
            self.calls = 0

        def create(self, **kwargs: object) -> SimpleNamespace:
            self.calls += 1
            if self.calls == 1:
                return SimpleNamespace(output_text='{"candidates": [{"kind": "UNKNOWN"}]}')
            instructions = kwargs["input"][0]["content"]  # type: ignore[index]
            assert "上一次返回无法通过 Schema 校验" in instructions
            return SimpleNamespace(output_text=__import__("json").dumps(valid_payload))

    responses = RetryResponses()
    extractor = LLMMemoryCandidateExtractor(
        SimpleNamespace(responses=responses),
        "memory-model",
    )

    extracted = await extractor.extract(evidence())

    assert responses.calls == 2
    assert extracted[0].kind is MemoryKind.FACT


@pytest.mark.asyncio
async def test_embedding_provider_forwards_dimensions_and_timeout() -> None:
    class FakeEmbeddings:
        def create(self, **kwargs: object) -> SimpleNamespace:
            assert kwargs == {
                "model": "text-embedding-3-small",
                "input": ["第一条", "第二条"],
                "timeout": 12.0,
                "dimensions": 512,
            }
            return SimpleNamespace(
                data=[
                    SimpleNamespace(index=1, embedding=[0.0, 1.0]),
                    SimpleNamespace(index=0, embedding=[1.0, 0.0]),
                ]
            )

    provider = OpenAIEmbeddingProvider(
        SimpleNamespace(embeddings=FakeEmbeddings()),
        "text-embedding-3-small",
        dimensions=512,
        request_timeout_seconds=12.0,
    )

    vectors = await provider.embed(["第一条", "第二条"])

    assert vectors == [[1.0, 0.0], [0.0, 1.0]]


@pytest.mark.asyncio
async def test_memory_policy_rejects_candidate_containing_credentials() -> None:
    unsafe = candidate(
        content="排查时发现配置包含 api_key=sk-1234567890abcdefghijkl，不应保存该凭据。",
        memory_key="project.security.leaked_key",
    )
    store = InMemoryLongTermMemoryStore()
    consolidator = MemoryConsolidator(StaticExtractor([unsafe]), store)

    result = await consolidator.consolidate(evidence())

    assert result.reviews[0].disposition is MemoryDisposition.REJECTED
    assert "候选疑似包含凭据或敏感信息" in result.reviews[0].reasons
    assert await store.all() == []


@pytest.mark.asyncio
async def test_same_memory_key_and_content_merges_evidence_sources() -> None:
    extractor = StaticExtractor([candidate()])
    store = InMemoryLongTermMemoryStore()
    consolidator = MemoryConsolidator(extractor, store)

    first = await consolidator.consolidate(evidence("run-1"))
    second = await consolidator.consolidate(evidence("run-2"))

    assert first.created
    assert second.reviews[0].disposition is MemoryDisposition.MERGED
    assert second.updated[0].source_run_ids == ["run-1", "run-2"]
    assert len(await store.all()) == 1


@pytest.mark.asyncio
async def test_same_memory_key_with_different_content_is_not_silently_overwritten() -> None:
    store = InMemoryLongTermMemoryStore()
    first = MemoryConsolidator(StaticExtractor([candidate()]), store)
    await first.consolidate(evidence("run-1"))
    changed = candidate(content="Bit Agent 修改代码后不需要执行任何测试即可结束任务。")
    second = MemoryConsolidator(StaticExtractor([changed]), store)

    result = await second.consolidate(evidence("run-2"))

    assert result.reviews[0].disposition is MemoryDisposition.CONFLICT
    stored = await store.all()
    assert len(stored) == 1
    assert stored[0].content == candidate().content


@pytest.mark.asyncio
async def test_retriever_returns_only_matches_above_threshold() -> None:
    store = InMemoryLongTermMemoryStore()
    consolidator = MemoryConsolidator(
        StaticExtractor([candidate()]),
        store,
        embedding_provider=StaticEmbedding(),
    )
    await consolidator.consolidate(evidence())
    retriever = MemoryRetriever(store, StaticEmbedding())

    matches = await retriever.retrieve("Docker 测试", project_id="bit_agent")

    assert len(matches) == 1
    assert matches[0].memory.memory_key == "project.testing.docker_required"


@pytest.mark.asyncio
async def test_eval_runner_consolidates_only_after_independent_success(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    (fixture / "code.py").write_text("value = 1\n", encoding="utf-8")
    case = EvalCase(
        name="memory-eval",
        prompt="修复 value",
        fixture_path=fixture,
        test_target=".",
        allowed_paths=["code.py"],
    )

    async def fake_agent(prompt: str, *, workspace_root: Path):
        from bit_agent.agent.result import AgentRunResult

        (workspace_root / "code.py").write_text("value = 2\n", encoding="utf-8")
        return AgentRunResult(
            status=AgentRunStatus.COMPLETED,
            final_answer="修复完成",
            rounds=1,
            changed_files=["code.py"],
            tests_passed=True,
        )

    async def fake_verifier(context: ToolContext, target: str) -> ToolResult:
        return ToolResult(
            tool_call_id="verify",
            tool_name="run_tests",
            status=ToolStatus.SUCCESS,
            output={"exit_code": 0},
            metadata=ToolMetadata(duration_ms=1, affected_paths=[target]),
        )

    store = InMemoryLongTermMemoryStore()
    extractor = StaticExtractor([candidate()])
    runner = EvalRunner(
        tmp_path / "results",
        agent_runner=fake_agent,
        verification_runner=fake_verifier,
        memory_consolidator=MemoryConsolidator(extractor, store),
        memory_project_id="bit_agent",
    )

    result = await runner.run(case)

    assert result.passed is True
    assert result.memory_consolidation is not None
    assert result.memory_consolidation.status is ConsolidationStatus.COMPLETED
    assert (result.artifact_directory / "memory_consolidation.json").is_file()
    assert extractor.calls == 1
