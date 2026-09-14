"""运行时 Context Manager 的预算、摘要、Artifact 与协议边界测试。"""

import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from bit_agent.context import (
    CONTEXT_SUMMARY_PREFIX,
    ContextManagementPolicy,
    ContextManager,
    ContextSummary,
    ContextWindowExceededError,
    FileContextArtifactStore,
    LLMContextSummarizer,
)
from bit_agent.memory import WorkingMemory
from bit_agent.memory.budget import estimate_tokens


class RecordingSummaryResponses:
    def __init__(self, *, fail_on_call: int | None = None) -> None:
        self.sources: list[str] = []
        self.fail_on_call = fail_on_call

    def create(self, **request: Any) -> SimpleNamespace:
        payload = json.loads(request["input"][1]["content"])
        source = payload["history_to_compact"]
        self.sources.append(source)
        if len(self.sources) == self.fail_on_call:
            raise TimeoutError("summary request timed out")
        return SimpleNamespace(
            output_text=ContextSummary(
                objective="Keep the existing public API",
                confirmed_facts=re.findall(r"REQUIREMENT_\d+", source),
            ).model_dump_json()
        )


def policy(**updates: Any) -> ContextManagementPolicy:
    defaults: dict[str, Any] = {
        "context_window_tokens": 3_000,
        "reserved_output_tokens": 200,
        "target_ratio": 0.30,
        "soft_limit_ratio": 0.45,
        "hard_limit_ratio": 0.90,
        "keep_recent_groups": 1,
        "minimum_recent_groups": 1,
        "tool_output_artifact_tokens": 1_000,
        "inline_tool_output_tokens": 100,
        "summarization_input_tokens": 1_000,
        "summary_tokens": 300,
    }
    defaults.update(updates)
    return ContextManagementPolicy(**defaults)


def tool_call(call_id: str) -> dict[str, str]:
    return {
        "type": "function_call",
        "call_id": call_id,
        "name": "read_file",
        "arguments": '{"path":"example.py"}',
    }


def tool_output(call_id: str, output: str) -> dict[str, str]:
    return {
        "type": "function_call_output",
        "call_id": call_id,
        "output": output,
    }


class StaticSummarizer:
    def __init__(self) -> None:
        self.calls: list[list[Any]] = []

    async def summarize(
        self,
        items: list[Any],
        *,
        previous_summary: ContextSummary | None,
        working_memory: WorkingMemory,
    ) -> ContextSummary:
        del previous_summary, working_memory
        self.calls.append(items)
        return ContextSummary(
            objective="模型擅自改写的目标",
            confirmed_facts=["旧调用已经完成"],
            unresolved_errors=["已经过期的错误"],
            next_actions=["继续定位"],
        )


class FailingSummarizer:
    async def summarize(self, *args: Any, **kwargs: Any) -> ContextSummary:
        raise RuntimeError("summary unavailable")


def test_policy_loads_environment_and_rejects_invalid_order() -> None:
    loaded = ContextManagementPolicy.from_environment(
        {
            "CONTEXT_WINDOW_TOKENS": "64000",
            "CONTEXT_RESERVED_OUTPUT_TOKENS": "4096",
            "CONTEXT_TARGET_RATIO": "0.5",
            "CONTEXT_SOFT_LIMIT_RATIO": "0.7",
            "CONTEXT_HARD_LIMIT_RATIO": "0.9",
            "CONTEXT_RECENT_GROUPS": "5",
        }
    )
    assert loaded.context_window_tokens == 64_000
    assert loaded.reserved_output_tokens == 4_096
    assert loaded.keep_recent_groups == 5
    assert loaded.target_tokens < loaded.soft_limit_tokens < loaded.hard_limit_tokens

    with pytest.raises(ValueError, match="target < soft < hard"):
        policy(target_ratio=0.6, soft_limit_ratio=0.5)


@pytest.mark.asyncio
async def test_large_tool_output_is_externalized_with_hash_and_preview(tmp_path: Path) -> None:
    raw_output = "first line\n" + ("x" * 2_000) + "\nlast error"
    history: list[Any] = [
        {"role": "user", "content": "排查错误"},
        tool_call("call-1"),
        tool_output("call-1", raw_output),
    ]
    manager = ContextManager(
        policy=policy(
            context_window_tokens=10_000,
            tool_output_artifact_tokens=100,
            inline_tool_output_tokens=40,
        ),
        artifact_store=FileContextArtifactStore(tmp_path / "artifacts"),
    )

    prepared = await manager.prepare(
        history,
        working_memory=WorkingMemory(thread_id="thread-1", objective="排查错误"),
        tools=[],
    )

    assert prepared.compacted is False
    assert len(manager.artifacts) == 1
    artifact = manager.artifacts[0]
    assert Path(artifact.path).read_text(encoding="utf-8") == raw_output
    placeholder = json.loads(history[2]["output"])
    assert placeholder["type"] == "bit_agent.context_artifact"
    assert placeholder["sha256"] == artifact.sha256
    assert "first line" in placeholder["preview"]
    assert "last error" in placeholder["preview"]


@pytest.mark.asyncio
async def test_compaction_preserves_recent_tool_pair_and_trusted_state() -> None:
    summarizer = StaticSummarizer()
    history: list[Any] = [{"role": "user", "content": "修复 calculator"}]
    for number in range(1, 5):
        call_id = f"call-{number}"
        history.extend(
            [
                tool_call(call_id),
                tool_output(call_id, f"result {number} " + ("x" * 900)),
            ]
        )
    memory = WorkingMemory(
        thread_id="thread-1",
        objective="修复 calculator",
        changed_files=["calculator.py"],
        unresolved_errors=[],
    )
    manager = ContextManager(policy=policy(), summarizer=summarizer)

    prepared = await manager.prepare(history, working_memory=memory, tools=[])

    assert prepared.compacted is True
    assert prepared.summary is not None
    assert prepared.summary.objective == "修复 calculator"
    assert prepared.summary.changes_made == ["calculator.py"]
    assert prepared.summary.unresolved_errors == []
    assert history[0] == {"role": "user", "content": "修复 calculator"}
    assert any(
        isinstance(item, dict)
        and isinstance(item.get("content"), str)
        and item["content"].startswith(CONTEXT_SUMMARY_PREFIX)
        for item in history
    )
    assert {item.get("call_id") for item in history if isinstance(item, dict)} >= {
        "call-4"
    }
    for call_id in {f"call-{number}" for number in range(1, 5)}:
        types = {
            item.get("type")
            for item in history
            if isinstance(item, dict) and item.get("call_id") == call_id
        }
        assert types in (set(), {"function_call", "function_call_output"})
    assert summarizer.calls


@pytest.mark.asyncio
async def test_summary_failure_uses_working_memory_without_reviving_old_errors() -> None:
    history: list[Any] = [{"role": "user", "content": "继续任务"}]
    for number in range(4):
        history.extend(
            [
                tool_call(f"call-{number}"),
                tool_output(f"call-{number}", "evidence " + ("x" * 900)),
            ]
        )
    memory = WorkingMemory(
        thread_id="thread-1",
        objective="继续任务",
        important_findings=["入口位于 app.py"],
        unresolved_errors=[],
    )
    manager = ContextManager(policy=policy(), summarizer=FailingSummarizer())

    prepared = await manager.prepare(history, working_memory=memory, tools=[])

    assert prepared.summary is not None
    assert prepared.summary.confirmed_facts == ["入口位于 app.py"]
    assert prepared.summary.unresolved_errors == []
    assert manager.warnings and "确定性降级" in manager.warnings[0]


@pytest.mark.asyncio
async def test_repeated_compaction_replaces_summary_and_preserves_previous_facts() -> None:
    summarizer = StaticSummarizer()
    history: list[Any] = [{"role": "user", "content": "长期任务"}]
    for number in range(4):
        history.extend(
            [
                tool_call(f"first-{number}"),
                tool_output(f"first-{number}", "first " + ("x" * 900)),
            ]
        )
    memory = WorkingMemory(thread_id="thread-1", objective="长期任务")
    manager = ContextManager(policy=policy(), summarizer=summarizer)

    first = await manager.prepare(history, working_memory=memory, tools=[])
    assert first.summary is not None
    assert "旧调用已经完成" in first.summary.confirmed_facts

    for number in range(4):
        history.extend(
            [
                tool_call(f"second-{number}"),
                tool_output(f"second-{number}", "second " + ("y" * 900)),
            ]
        )
    second = await manager.prepare(history, working_memory=memory, tools=[])

    assert second.compacted is True
    assert second.summary is not None
    assert "旧调用已经完成" in second.summary.confirmed_facts
    assert manager.compaction_count >= 2
    summary_messages = [
        item
        for item in history
        if isinstance(item, dict)
        and isinstance(item.get("content"), str)
        and item["content"].startswith(CONTEXT_SUMMARY_PREFIX)
    ]
    assert len(summary_messages) == 1


@pytest.mark.asyncio
async def test_unanswered_tool_call_is_never_removed() -> None:
    history: list[Any] = [
        {"role": "user", "content": "继续任务"},
        tool_call("pending-call"),
    ]
    for number in range(4):
        history.extend(
            [
                {"type": "message", "text": "old message " + ("x" * 800)},
                tool_call(f"done-{number}"),
                tool_output(f"done-{number}", "done " + ("x" * 500)),
            ]
        )
    manager = ContextManager(policy=policy(), summarizer=StaticSummarizer())

    await manager.prepare(
        history,
        working_memory=WorkingMemory(thread_id="thread-1", objective="继续任务"),
        tools=[],
    )

    assert any(
        isinstance(item, dict)
        and item.get("type") == "function_call"
        and item.get("call_id") == "pending-call"
        for item in history
    )


@pytest.mark.asyncio
async def test_critical_content_over_hard_limit_fails_explicitly() -> None:
    manager = ContextManager(policy=policy(context_window_tokens=1_500))
    history = [{"role": "user", "content": "必须保留" + ("x" * 10_000)}]

    with pytest.raises(ContextWindowExceededError, match="关键内容超过安全上限"):
        await manager.prepare(
            history,
            working_memory=WorkingMemory(thread_id="thread-1", objective="必须保留"),
            tools=[],
        )


@pytest.mark.asyncio
async def test_llm_summarizer_accepts_json_inside_markdown() -> None:
    class FakeResponses:
        def __init__(self) -> None:
            self.request: dict[str, Any] | None = None

        def create(self, **kwargs: Any) -> SimpleNamespace:
            self.request = kwargs
            return SimpleNamespace(
                output_text=(
                    "```json\n"
                    '{"objective":"任务","constraints":[],"confirmed_facts":[],\n'
                    '"files_examined":[],"changes_made":[],"failed_attempts":[],\n'
                    '"unresolved_errors":[],"next_actions":[]}\n'
                    "```"
                )
            )

    responses = FakeResponses()
    client = SimpleNamespace(responses=responses)
    summarizer = LLMContextSummarizer(client, "summary-model")
    result = await summarizer.summarize(
        [{"role": "user", "content": "历史"}],
        previous_summary=None,
        working_memory=WorkingMemory(thread_id="thread-1", objective="任务"),
    )

    assert result.objective == "任务"
    assert responses.request is not None
    assert responses.request["model"] == "summary-model"
    assert "tools" not in responses.request


@pytest.mark.asyncio
async def test_llm_summarizer_reads_all_history_within_each_request_budget() -> None:
    responses = RecordingSummaryResponses()
    summarizer = LLMContextSummarizer(
        SimpleNamespace(responses=responses), "summary-model", max_source_tokens=256,
    )
    history = [
        {"role": "user", "content": f"REQUIREMENT_{number:02d} " + "detail " * 80}
        for number in range(12)
    ]
    result = await summarizer.summarize(
        history,
        previous_summary=ContextSummary(objective="task", confirmed_facts=["previous fact"]),
        working_memory=WorkingMemory(thread_id="thread", objective="task"),
    )

    assert len(responses.sources) > 1
    assert all(estimate_tokens(source) <= 256 for source in responses.sources)
    assert set(result.confirmed_facts) == {
        "previous fact", *(f"REQUIREMENT_{number:02d}" for number in range(12)),
    }


@pytest.mark.asyncio
async def test_compaction_keeps_middle_requirements_when_summary_input_is_smaller() -> None:
    responses = RecordingSummaryResponses()
    manager = ContextManager(
        policy=policy(),
        summarizer=LLMContextSummarizer(
            SimpleNamespace(responses=responses), "summary-model", max_source_tokens=256,
        ),
    )
    history = [{"role": "user", "content": "Keep the existing public API"}]
    history.extend(
        {"role": "user", "content": f"REQUIREMENT_{number:02d} " + "detail " * 150}
        for number in range(12)
    )
    prepared = await manager.prepare(
        history,
        working_memory=WorkingMemory(thread_id="thread", objective="task"),
        tools=[],
    )

    assert prepared.compacted
    restored = json.dumps(prepared.items)
    assert all(f"REQUIREMENT_{number:02d}" in restored for number in range(12))


@pytest.mark.asyncio
@pytest.mark.parametrize("window", [3000, 5000])
async def test_failed_summary_batch_preserves_original_history(window: int) -> None:
    responses = RecordingSummaryResponses(fail_on_call=2)
    manager = ContextManager(
        policy=policy(context_window_tokens=window),
        summarizer=LLMContextSummarizer(
            SimpleNamespace(responses=responses), "summary-model", max_source_tokens=256,
        ),
    )
    history = [{"role": "user", "content": "Keep the existing public API"}]
    history.extend(
        {"role": "user", "content": f"REQUIREMENT_{number:02d} " + "detail " * 150}
        for number in range(12)
    )
    original = list(history)
    memory = WorkingMemory(thread_id="thread", objective="task")
    if window == 3000:
        with pytest.raises(ContextWindowExceededError):
            await manager.prepare(history, working_memory=memory, tools=[])
    else:
        prepared = await manager.prepare(history, working_memory=memory, tools=[])
        assert not prepared.compacted

    assert len(responses.sources) == 2
    assert history == original
    assert manager.warnings and "保留" in manager.warnings[0]

    retried = await manager.prepare(history, working_memory=memory, tools=[])
    assert retried.compacted
    assert all(f"REQUIREMENT_{number:02d}" in json.dumps(history) for number in range(12))
