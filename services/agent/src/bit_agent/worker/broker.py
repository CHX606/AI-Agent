"""Redis 任务队列、状态存储和取消协商。"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from bit_agent.worker.models import QueuedTask, TaskStatus

CLAIM_SCRIPT = """
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'QUEUED' then return 0 end
redis.call('HSET', KEYS[1],
  'status', 'RUNNING',
  'worker_id', ARGV[1],
  'started_at', ARGV[2],
  'updated_at', ARGV[2])
return 1
"""

FINISH_SCRIPT = """
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return 'MISSING' end
if current == 'CANCELLED'
  or current == 'COMPLETED'
  or current == 'PARTIAL'
  or current == 'FAILED' then
  return current
end
local final_status = ARGV[1]
local result_json = ARGV[3]
local error = ARGV[4]
local run_id = ARGV[5]
if current == 'CANCELLATION_REQUESTED' then
  final_status = 'CANCELLED'
  result_json = ''
  error = ''
  run_id = ''
end
redis.call('HSET', KEYS[1],
  'status', final_status,
  'updated_at', ARGV[2],
  'completed_at', ARGV[2],
  'result_json', result_json,
  'error', error,
  'run_id', run_id)
return final_status
"""


@dataclass(frozen=True, slots=True)
class DequeuedTask:
    task: QueuedTask
    receipt: str


class RedisTaskBroker:
    def __init__(
        self,
        client: Any,
        *,
        key_prefix: str = "bit-agent:tasks",
        queue_key: str = "bit-agent:tasks:queue",
        processing_key: str = "bit-agent:tasks:processing",
    ) -> TaskStatus:
        self.client = client
        self.key_prefix = key_prefix
        self.queue_key = queue_key
        self.processing_key = processing_key

    @classmethod
    def from_url(
        cls,
        url: str,
        *,
        key_prefix: str = "bit-agent:tasks",
        queue_key: str = "bit-agent:tasks:queue",
        processing_key: str = "bit-agent:tasks:processing",
    ) -> "RedisTaskBroker":
        try:
            from redis.asyncio import Redis
        except ImportError as exc:
            raise RuntimeError("启动 Worker 需要安装 memory 可选依赖") from exc
        return cls(
            Redis.from_url(url, decode_responses=True),
            key_prefix=key_prefix,
            queue_key=queue_key,
            processing_key=processing_key,
        )

    async def dequeue(self, *, timeout_seconds: int = 5) -> DequeuedTask | None:
        raw = await self.client.blmove(
            self.queue_key,
            self.processing_key,
            timeout_seconds,
            "LEFT",
            "RIGHT",
        )
        if raw is None:
            return None
        return DequeuedTask(task=QueuedTask.model_validate_json(raw), receipt=raw)

    async def acknowledge(self, receipt: str) -> None:
        await self.client.lrem(self.processing_key, 1, receipt)

    async def claim(self, task_id: str, worker_id: str) -> bool:
        result = await self.client.eval(
            CLAIM_SCRIPT,
            1,
            self.task_key(task_id),
            worker_id,
            _now(),
        )
        return bool(result)

    async def get_status(self, task_id: str) -> TaskStatus | None:
        raw = await self.client.hget(self.task_key(task_id), "status")
        return TaskStatus(raw) if raw else None

    async def finish(
        self,
        task_id: str,
        *,
        status: TaskStatus,
        result: Any | None = None,
        error: str | None = None,
        run_id: str | None = None,
    ) -> None:
        if status not in {
            TaskStatus.CANCELLED,
            TaskStatus.COMPLETED,
            TaskStatus.PARTIAL,
            TaskStatus.FAILED,
        }:
            raise ValueError("finish 只能写入终态")
        now = _now()
        final_status = await self.client.eval(
            FINISH_SCRIPT,
            1,
            self.task_key(task_id),
            status.value,
            now,
            _serialize_result(result),
            error or "",
            run_id or "",
        )
        if final_status == "MISSING":
            raise RuntimeError(f"任务状态不存在：{task_id}")
        return TaskStatus(final_status)

    def task_key(self, task_id: str) -> str:
        return f"{self.key_prefix}:{task_id}"

    def event_key(self, task_id: str) -> str:
        return f"{self.task_key(task_id)}:events"

    async def close(self) -> None:
        await self.client.aclose()


def _serialize_result(result: Any | None) -> str:
    if result is None:
        return ""
    model_dump_json = getattr(result, "model_dump_json", None)
    if callable(model_dump_json):
        return str(model_dump_json())
    return json.dumps(result, ensure_ascii=False, default=str)


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
