"""Redis Worker 的任务执行、状态映射和取消测试。"""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from bit_agent.multi_agent import MultiAgentRunStatus
from bit_agent.worker import AgentWorker, DequeuedTask, QueuedTask, TaskStatus


class FakeRedis:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, str]]] = []

    async def xadd(self, key: str, values: dict[str, str], **_kwargs: Any) -> str:
        self.events.append((key, values))
        return "1-0"

    async def expire(self, _key: str, _seconds: int) -> bool:
        return True


class FakeBroker:
    def __init__(self, task: QueuedTask) -> None:
        self.task = task
        self.client = FakeRedis()
        self.status = TaskStatus.QUEUED
        self.finished: dict[str, Any] | None = None
        self.acknowledged: list[str] = []

    async def dequeue(self, *, timeout_seconds: int = 1) -> DequeuedTask | None:
        del timeout_seconds
        task, self.task = self.task, None  # type: ignore[assignment]
        return DequeuedTask(task=task, receipt="receipt-1")

    async def acknowledge(self, receipt: str) -> None:
        self.acknowledged.append(receipt)

    async def claim(self, _task_id: str, _worker_id: str) -> bool:
        if self.status is not TaskStatus.QUEUED:
            return False
        self.status = TaskStatus.RUNNING
        return True

    async def get_status(self, _task_id: str) -> TaskStatus:
        return self.status

    async def finish(self, _task_id: str, **values: Any) -> None:
        self.status = values["status"]
        self.finished = values

    def event_key(self, task_id: str) -> str:
        return f"bit-agent:tasks:{task_id}:events"

    def task_key(self, task_id: str) -> str:
        return f"bit-agent:tasks:{task_id}"


def queued_task(workspace: Path) -> QueuedTask:
    return QueuedTask.model_validate(
        {
            "task_id": "task-1",
            "objective": "修复失败测试",
            "workspace_root": str(workspace),
            "created_at": "2026-09-03T00:00:00Z",
        }
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [100, 37])
async def test_worker_runs_task_and_persists_structured_result(tmp_path: Path, limit: int) -> None:
    broker = FakeBroker(queued_task(tmp_path).model_copy(update={"max_tool_rounds": limit}))

    async def runner(*_args: Any, **kwargs: Any) -> Any:
        assert kwargs["workspace_root"] == tmp_path.resolve()
        assert kwargs["event_sink"].stream_key.endswith(":task-1:events")
        assert kwargs["subagent_options"]["working_memory_store"].client is broker.client
        assert kwargs["main_agent_options"]["working_memory_store"].client is broker.client
        assert kwargs["main_agent_options"]["max_tool_rounds"] == limit
        return SimpleNamespace(
            status=MultiAgentRunStatus.COMPLETED,
            error=None,
            run_id="run-1",
            model_dump_json=lambda: '{"status":"COMPLETED"}',
        )

    worker = AgentWorker(broker, worker_id="worker-1", runner=runner)  # type: ignore[arg-type]
    assert await worker.run_once()
    assert broker.status is TaskStatus.COMPLETED
    assert broker.finished is not None
    assert broker.finished["run_id"] == "run-1"
    assert broker.acknowledged == ["receipt-1"]


@pytest.mark.asyncio
async def test_worker_stops_running_task_after_cancellation(tmp_path: Path) -> None:
    broker = FakeBroker(queued_task(tmp_path))
    started = asyncio.Event()

    async def runner(*_args: Any, **_kwargs: Any) -> Any:
        started.set()
        await asyncio.Event().wait()

    worker = AgentWorker(
        broker,  # type: ignore[arg-type]
        worker_id="worker-1",
        runner=runner,  # type: ignore[arg-type]
        cancellation_poll_seconds=0.001,
    )
    running = asyncio.create_task(worker.run_once())
    await started.wait()
    broker.status = TaskStatus.CANCELLATION_REQUESTED
    assert await running
    assert broker.status is TaskStatus.CANCELLED


@pytest.mark.asyncio
async def test_worker_rejects_missing_workspace(tmp_path: Path) -> None:
    broker = FakeBroker(queued_task(tmp_path / "missing"))
    called = False

    async def runner(*_args: Any, **_kwargs: Any) -> Any:
        nonlocal called
        called = True

    worker = AgentWorker(broker, worker_id="worker-1", runner=runner)  # type: ignore[arg-type]
    assert await worker.run_once()
    assert not called
    assert broker.status is TaskStatus.FAILED
    assert broker.finished is not None
    assert "工作区不存在" in broker.finished["error"]
