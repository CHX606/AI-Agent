"""结构化事件、顺序保证和 Sink 故障隔离测试。"""

import asyncio
import json
from pathlib import Path

import pytest
from bit_agent.agent import AgentRunStatus, run_agent
from bit_agent.observability import (
    AgentEvent,
    AgentEventType,
    EventBus,
    InMemoryEventSink,
    JsonlEventSink,
    RedisEventSink,
)


@pytest.mark.asyncio
async def test_event_bus_assigns_global_sequence_and_writes_jsonl(tmp_path: Path) -> None:
    memory_sink = InMemoryEventSink()
    log_path = tmp_path / "trace.jsonl"
    bus = EventBus("trace-1", [memory_sink, JsonlEventSink(log_path)])

    await asyncio.gather(
        *(
            bus.emit(
                AgentEventType.TOOL_COMPLETED,
                run_id=f"run-{index}",
                agent_id=f"agent-{index}",
                payload={"index": index},
            )
            for index in range(10)
        )
    )

    assert [event.sequence for event in memory_sink.events] == list(range(1, 11))
    lines = log_path.read_text(encoding="utf-8").splitlines()
    persisted = [AgentEvent.model_validate(json.loads(line)) for line in lines]
    assert [event.sequence for event in persisted] == list(range(1, 11))
    assert bus.artifact_paths == [str(log_path.resolve())]


@pytest.mark.asyncio
async def test_event_sink_failure_does_not_break_other_sinks() -> None:
    class BrokenSink:
        async def emit(self, _event: AgentEvent) -> None:
            raise OSError("日志磁盘不可用")

    memory_sink = InMemoryEventSink()
    bus = EventBus("trace-1", [BrokenSink(), memory_sink])

    await bus.emit(
        AgentEventType.AGENT_STARTED,
        run_id="run-1",
        agent_id="main",
    )

    assert len(memory_sink.events) == 1
    assert bus.warnings == ["BrokenSink: OSError: 日志磁盘不可用"]


@pytest.mark.asyncio
async def test_redis_event_sink_writes_agent_event_to_stream() -> None:
    class FakeRedis:
        def __init__(self) -> None:
            self.values: list[tuple[str, dict[str, str], dict[str, object]]] = []
            self.expirations: list[tuple[str, int]] = []

        async def xadd(
            self,
            key: str,
            values: dict[str, str],
            **options: object,
        ) -> str:
            self.values.append((key, values, options))
            return "1-0"

        async def expire(self, key: str, seconds: int) -> None:
            self.expirations.append((key, seconds))

    redis = FakeRedis()
    sink = RedisEventSink(redis, "tasks:one:events", max_events=50, ttl_seconds=60)
    event = AgentEvent(
        trace_id="trace-1",
        run_id="run-1",
        sequence=1,
        event_type=AgentEventType.AGENT_STARTED,
        timestamp="2026-09-03T00:00:00Z",
        agent_id="main",
    )

    await sink.emit(event)

    key, values, options = redis.values[0]
    assert key == "tasks:one:events"
    assert json.loads(values["event"])["event_type"] == "AGENT_STARTED"
    assert options == {"maxlen": 50, "approximate": True}
    assert redis.expirations == [("tasks:one:events", 60)]


@pytest.mark.asyncio
async def test_agent_runtime_emits_structured_lifecycle_events(tmp_path: Path) -> None:
    class Responses:
        def create(self, **_kwargs: object) -> object:
            return type("Response", (), {"output": [], "output_text": "完成"})()

    sink = InMemoryEventSink()
    result = await run_agent(
        "查看项目",
        workspace_root=tmp_path,
        response_client=type("Client", (), {"responses": Responses()})(),
        model_name="test-model",
        event_sink=sink,
    )

    assert result.status is AgentRunStatus.COMPLETED
    assert [event.event_type for event in sink.events] == [
        AgentEventType.AGENT_STARTED,
        AgentEventType.MODEL_REQUESTED,
        AgentEventType.MODEL_RESPONDED,
        AgentEventType.AGENT_COMPLETED,
    ]
    assert result.event_count == 4
    assert result.event_trace_id == result.run_id
    assert result.event_warnings == []
