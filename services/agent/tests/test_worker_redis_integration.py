"""Python Worker 与真实 Redis 队列协议的可选集成测试。"""

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from bit_agent.multi_agent import MultiAgentRunStatus
from bit_agent.worker import AgentWorker, RedisTaskBroker, TaskStatus

REDIS_URL = os.getenv("BIT_AGENT_TEST_TASK_REDIS_URL")


@pytest.mark.skipif(not REDIS_URL, reason="未配置真实 Worker Redis 集成测试地址")
@pytest.mark.asyncio
async def test_worker_broker_claims_and_finishes_task(tmp_path: Path) -> None:
    namespace = f"bit-agent:test:{uuid4().hex}"
    queue_key = f"{namespace}:queue"
    processing_key = f"{namespace}:processing"
    broker = RedisTaskBroker.from_url(
        REDIS_URL or "",
        key_prefix=namespace,
        queue_key=queue_key,
        processing_key=processing_key,
    )
    task_id = uuid4().hex
    task_key = broker.task_key(task_id)
    payload = {
        "task_id": task_id,
        "objective": "检查 Worker 队列协议",
        "workspace_root": str(tmp_path),
        "created_at": "2026-09-03T00:00:00Z",
    }
    await broker.client.hset(
        task_key,
        mapping={
            **payload,
            "status": "QUEUED",
            "updated_at": payload["created_at"],
        },
    )
    await broker.client.rpush(queue_key, json.dumps(payload, ensure_ascii=False))

    try:
        dequeued = await broker.dequeue(timeout_seconds=1)
        assert dequeued is not None
        assert dequeued.task.task_id == task_id
        assert await broker.client.llen(processing_key) == 1
        assert await broker.claim(task_id, "worker-test")
        assert await broker.get_status(task_id) is TaskStatus.RUNNING

        await broker.finish(
            task_id,
            status=TaskStatus.COMPLETED,
            result={"ok": True},
            run_id="run-test",
        )
        await broker.acknowledge(dequeued.receipt)

        values = await broker.client.hgetall(task_key)
        assert values["status"] == "COMPLETED"
        assert json.loads(values["result_json"]) == {"ok": True}
        assert await broker.client.llen(processing_key) == 0

        cancelled_task_id = uuid4().hex
        cancelled_key = broker.task_key(cancelled_task_id)
        await broker.client.hset(
            cancelled_key,
            mapping={"status": "CANCELLATION_REQUESTED"},
        )
        final_status = await broker.finish(
            cancelled_task_id,
            status=TaskStatus.COMPLETED,
            result={"should_not_be_saved": True},
            run_id="late-run",
        )
        cancelled_values = await broker.client.hgetall(cancelled_key)
        assert final_status is TaskStatus.CANCELLED
        assert cancelled_values["status"] == "CANCELLED"
        assert cancelled_values["result_json"] == ""
    finally:
        keys = await broker.client.keys(f"{namespace}:*")
        if keys:
            await broker.client.delete(*keys)
        await broker.close()


@pytest.mark.skipif(not REDIS_URL, reason="未配置真实 Worker Redis 集成测试地址")
@pytest.mark.asyncio
async def test_agent_worker_consumes_gateway_payload_and_saves_result(tmp_path: Path) -> None:
    namespace = f"bit-agent:test:{uuid4().hex}"
    queue_key = f"{namespace}:queue"
    processing_key = f"{namespace}:processing"
    broker = RedisTaskBroker.from_url(
        REDIS_URL or "",
        key_prefix=namespace,
        queue_key=queue_key,
        processing_key=processing_key,
    )
    task_id = uuid4().hex
    payload = {
        "task_id": task_id,
        "objective": "运行完整 Worker 消费流程",
        "workspace_root": str(tmp_path),
        "created_at": "2026-09-03T00:00:00Z",
    }
    await broker.client.hset(
        broker.task_key(task_id),
        mapping={**payload, "status": "QUEUED", "updated_at": payload["created_at"]},
    )
    await broker.client.rpush(queue_key, json.dumps(payload, ensure_ascii=False))

    async def runner(*_args: Any, **kwargs: Any) -> Any:
        assert kwargs["event_sink"].stream_key == broker.event_key(task_id)
        assert kwargs["main_agent_options"]["working_memory_store"].client is broker.client
        return SimpleNamespace(
            status=MultiAgentRunStatus.COMPLETED,
            error=None,
            run_id="real-redis-run",
            model_dump_json=lambda: '{"status":"COMPLETED","tests_passed":true}',
        )

    worker = AgentWorker(broker, worker_id="integration-worker", runner=runner)  # type: ignore[arg-type]
    try:
        assert await worker.run_once(timeout_seconds=1)
        values = await broker.client.hgetall(broker.task_key(task_id))
        assert values["status"] == "COMPLETED"
        assert values["run_id"] == "real-redis-run"
        assert json.loads(values["result_json"])["tests_passed"] is True
        assert await broker.client.llen(processing_key) == 0
    finally:
        keys = await broker.client.keys(f"{namespace}:*")
        if keys:
            await broker.client.delete(*keys)
        await broker.close()
