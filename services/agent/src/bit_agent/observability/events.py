"""Agent Harness 的结构化事件模型与顺序事件总线。"""

import asyncio
import json
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, JsonValue


class AgentEventType(StrEnum):
    TRACE_STARTED = "TRACE_STARTED"
    TRACE_COMPLETED = "TRACE_COMPLETED"
    TRACE_FAILED = "TRACE_FAILED"
    PLANNING_STARTED = "PLANNING_STARTED"
    PLANNING_COMPLETED = "PLANNING_COMPLETED"
    DISPATCH_STARTED = "DISPATCH_STARTED"
    DISPATCH_COMPLETED = "DISPATCH_COMPLETED"
    AGGREGATION_COMPLETED = "AGGREGATION_COMPLETED"
    AGENT_STARTED = "AGENT_STARTED"
    AGENT_COMPLETED = "AGENT_COMPLETED"
    AGENT_FAILED = "AGENT_FAILED"
    MODEL_REQUESTED = "MODEL_REQUESTED"
    MODEL_RESPONDED = "MODEL_RESPONDED"
    MODEL_TEXT_DELTA = "MODEL_TEXT_DELTA"
    TOOL_REQUESTED = "TOOL_REQUESTED"
    TOOL_COMPLETED = "TOOL_COMPLETED"
    VERIFICATION_REQUIRED = "VERIFICATION_REQUIRED"
    CONTEXT_COMPACTED = "CONTEXT_COMPACTED"
    MEMORY_RECALLED = "MEMORY_RECALLED"


class AgentEvent(BaseModel):
    """一条可写入日志、推送前端或用于统计的稳定事件。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    trace_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    sequence: int = Field(gt=0)
    event_type: AgentEventType
    timestamp: datetime
    agent_id: str = Field(min_length=1)
    task_id: str | None = None
    payload: dict[str, JsonValue] = Field(default_factory=dict)


@runtime_checkable
class EventSink(Protocol):
    async def emit(self, event: AgentEvent) -> None: ...


class InMemoryEventSink:
    """供测试、Notebook 或上层服务直接读取事件。"""

    def __init__(self) -> None:
        self.events: list[AgentEvent] = []

    async def emit(self, event: AgentEvent) -> None:
        self.events.append(event)


class JsonlEventSink:
    """每行保存一个完整 JSON 事件，便于流式追加和故障恢复。"""

    def __init__(self, path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    async def emit(self, event: AgentEvent) -> None:
        line = event.model_dump_json() + "\n"
        await asyncio.to_thread(self._append, line)

    def _append(self, line: str) -> None:
        with self.path.open("a", encoding="utf-8", newline="") as stream:
            stream.write(line)


class RedisEventSink:
    """把事件写入 Redis Stream，供 Gateway 通过 SSE 实时转发。"""

    def __init__(
        self,
        client: Any,
        stream_key: str,
        *,
        max_events: int = 10_000,
        ttl_seconds: int = 7 * 24 * 60 * 60,
    ) -> None:
        if not stream_key.strip():
            raise ValueError("stream_key 不能为空")
        if max_events <= 0 or ttl_seconds <= 0:
            raise ValueError("事件上限和过期时间必须大于 0")
        self.client = client
        self.stream_key = stream_key.strip()
        self.max_events = max_events
        self.ttl_seconds = ttl_seconds

    async def emit(self, event: AgentEvent) -> None:
        await self.client.xadd(
            self.stream_key,
            {"event": event.model_dump_json()},
            maxlen=self.max_events,
            approximate=True,
        )
        await self.client.expire(self.stream_key, self.ttl_seconds)


class EventBus:
    """为并发 Agent 分配全局递增序号，并隔离 Sink 故障。"""

    def __init__(self, trace_id: str, sinks: list[EventSink] | None = None) -> None:
        if not trace_id.strip():
            raise ValueError("trace_id 不能为空")
        self.trace_id = trace_id.strip()
        self.sinks = list(sinks or [])
        self.warnings: list[str] = []
        self._sequence = 0
        self._lock = asyncio.Lock()

    async def emit(
        self,
        event_type: AgentEventType,
        *,
        run_id: str,
        agent_id: str,
        task_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> AgentEvent:
        async with self._lock:
            self._sequence += 1
            event = AgentEvent(
                trace_id=self.trace_id,
                run_id=run_id,
                sequence=self._sequence,
                event_type=event_type,
                timestamp=datetime.now(UTC),
                agent_id=agent_id,
                task_id=task_id,
                payload=_json_payload(payload or {}),
            )
            for sink in self.sinks:
                try:
                    await sink.emit(event)
                except Exception as exc:
                    warning = f"{type(sink).__name__}: {type(exc).__name__}: {exc}"
                    if warning not in self.warnings:
                        self.warnings.append(warning)
            return event

    @property
    def event_count(self) -> int:
        return self._sequence

    @property
    def artifact_paths(self) -> list[str]:
        paths = {
            str(path)
            for sink in self.sinks
            if isinstance((path := getattr(sink, "path", None)), Path)
        }
        return sorted(paths)


def _json_payload(payload: dict[str, Any]) -> dict[str, JsonValue]:
    serialized = json.loads(json.dumps(payload, ensure_ascii=False, default=str))
    if not isinstance(serialized, dict):
        raise ValueError("事件 payload 必须是 JSON object")
    return serialized
