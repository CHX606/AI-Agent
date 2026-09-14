"""从 Redis 消费任务并运行 Bit Agent Multi-Agent。"""

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

from bit_agent.memory import RedisWorkingMemoryStore
from bit_agent.multi_agent import MultiAgentRunResult, MultiAgentRunStatus, run_multi_agent
from bit_agent.observability import RedisEventSink
from bit_agent.worker.broker import RedisTaskBroker
from bit_agent.worker.models import QueuedTask, TaskStatus

AgentRunner = Callable[..., Awaitable[MultiAgentRunResult]]


class AgentWorker:
    def __init__(
        self,
        broker: RedisTaskBroker,
        *,
        worker_id: str,
        runner: AgentRunner = run_multi_agent,
        task_timeout_seconds: float = 3_600,
        cancellation_poll_seconds: float = 0.5,
    ) -> None:
        if not worker_id.strip():
            raise ValueError("worker_id 不能为空")
        if task_timeout_seconds <= 0 or cancellation_poll_seconds <= 0:
            raise ValueError("超时配置必须大于 0")
        self.broker = broker
        self.worker_id = worker_id.strip()
        self.runner = runner
        self.task_timeout_seconds = task_timeout_seconds
        self.cancellation_poll_seconds = cancellation_poll_seconds

    async def run_forever(self) -> None:
        while True:
            await self.run_once(timeout_seconds=5)

    async def run_once(self, *, timeout_seconds: int = 1) -> bool:
        dequeued = await self.broker.dequeue(timeout_seconds=timeout_seconds)
        if dequeued is None:
            return False
        await self._process(dequeued.task)
        await self.broker.acknowledge(dequeued.receipt)
        return True

    async def _process(self, task: QueuedTask) -> None:
        if not await self.broker.claim(task.task_id, self.worker_id):
            return

        workspace = Path(task.workspace_root).resolve()
        if not workspace.is_dir():
            await self.broker.finish(
                task.task_id,
                status=TaskStatus.FAILED,
                error=f"工作区不存在或不是目录：{workspace}",
            )
            return

        event_sink = RedisEventSink(
            self.broker.client,
            self.broker.event_key(task.task_id),
        )
        working_memory_store = RedisWorkingMemoryStore(
            self.broker.client,
            key_prefix=f"{self.broker.task_key(task.task_id)}:working-memory:",
        )
        agent_task = asyncio.create_task(
            self.runner(
                task.objective,
                workspace_root=workspace,
                event_sink=event_sink,
                subagent_options={"working_memory_store": working_memory_store},
                main_agent_options={
                    "working_memory_store": working_memory_store,
                    "max_tool_rounds": task.max_tool_rounds,
                },
            )
        )
        cancellation_task = asyncio.create_task(
            self._cancel_when_requested(task.task_id, agent_task)
        )
        try:
            result = await asyncio.wait_for(agent_task, timeout=self.task_timeout_seconds)
        except asyncio.CancelledError:
            if await self.broker.get_status(task.task_id) is not TaskStatus.CANCELLATION_REQUESTED:
                raise
            await self.broker.finish(task.task_id, status=TaskStatus.CANCELLED)
        except TimeoutError:
            await self.broker.finish(
                task.task_id,
                status=TaskStatus.FAILED,
                error=f"任务超过 Worker 超时：{self.task_timeout_seconds:g} 秒",
            )
        except Exception as exc:
            await self.broker.finish(
                task.task_id,
                status=TaskStatus.FAILED,
                error=f"{type(exc).__name__}: {exc}"[:4_000],
            )
        else:
            status = {
                MultiAgentRunStatus.COMPLETED: TaskStatus.COMPLETED,
                MultiAgentRunStatus.PARTIAL: TaskStatus.PARTIAL,
                MultiAgentRunStatus.FAILED: TaskStatus.FAILED,
            }[result.status]
            await self.broker.finish(
                task.task_id,
                status=status,
                result=result,
                error=result.error,
                run_id=result.run_id,
            )
        finally:
            cancellation_task.cancel()
            with suppress(asyncio.CancelledError):
                await cancellation_task

    async def _cancel_when_requested(
        self,
        task_id: str,
        agent_task: asyncio.Task[Any],
    ) -> None:
        while not agent_task.done():
            await asyncio.sleep(self.cancellation_poll_seconds)
            if await self.broker.get_status(task_id) is TaskStatus.CANCELLATION_REQUESTED:
                agent_task.cancel()
                return
