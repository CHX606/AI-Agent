from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from bit_agent.observability.diagnostics import diagnostic_context, failure, public_error, record
from bit_agent.observability.usage import UsageMeter, current_meter
from bit_agent.runtime.application.capacity import ExecutionSlot

from .service_protocol import now
from .task_run_configuration import TaskRunConfiguration


class TaskExecution(TaskRunConfiguration):
    async def _execute(self, task: dict[str, Any]) -> None:
        token = current_meter.set(UsageMeter())
        try:
            with diagnostic_context(task_id=task["task_id"], session_id=task["session_id"]):
                await self._execute_task(task)
        finally:
            current_meter.reset(token)

    async def _execute_task(self, task: dict[str, Any]) -> None:
        task_id, session_id = task["task_id"], task["session_id"]
        control = self._interactions[task_id]
        try:
            await self._run_task(task, control)
        except asyncio.CancelledError:
            record("info", "task_cancelled")
            await self._finish(
                task_id, "CANCELLED", error="执行已停止；记录保留，不会自动重复执行工具。"
            )
        except TimeoutError as exc:
            identifier = failure("task_timeout", exc)
            await self._finish(
                task_id,
                "FAILED",
                error=public_error(identifier, "任务执行超时，已保存记录仍可查看"),
            )
        except Exception as exc:
            identifier = failure("task_failed", exc)
            await self._finish(task_id, "FAILED", error=public_error(identifier))
        finally:
            control.close()
            self._running.pop(task_id, None)
            if self._sessions.get(session_id) == task_id:
                self._sessions.pop(session_id, None)

    async def _run_task(self, task: dict[str, Any], control) -> None:
        root = Path(task["workspace_root"])
        async with self._workspaces.hold(root), ExecutionSlot(self._slots) as slot:
            control.slot = slot
            current = await self.get_task(task["task_id"])
            if current is None or current["status"] in {"CANCELLED", "CANCELLATION_REQUESTED"}:
                await self._finish(task["task_id"], "CANCELLED")
                return
            await self._execute_active_task(task, control)

    async def _execute_active_task(self, task: dict[str, Any], control) -> None:
        from . import service

        task_id = task["task_id"]
        await self.storage.call("update_task", task_id, {"status": "RUNNING", "started_at": now()})
        # 开始前保存上下文快照，之后才能“编辑并重发”或“重新生成”这一轮。
        await self.storage.call("checkpoint_turn", task["session_id"], task_id)
        options, journal = await self._task_run_options(task, control)
        timeout = float(os.getenv("BIT_AGENT_TASK_TIMEOUT_SECONDS", "3600"))
        if timeout <= 0:
            raise ValueError("任务超时必须大于 0")
        async with asyncio.timeout(timeout) as deadline:
            control.deadline = deadline
            result = await service.run_agent(task["objective"], **options)
        current = await self.get_task(task_id)
        status = (
            "CANCELLED"
            if current and current["status"] == "CANCELLATION_REQUESTED"
            else result.status
        )
        await self._finish(
            task_id, status, result=result.model_dump(mode="json"), error=result.error
        )
        if status == "COMPLETED":
            self._learn_later(task, result, [entry["patch"] for entry in journal.entries])

    async def _finish(self, task_id: str, status: str, **fields: Any) -> None:
        control = self._interactions.get(task_id)
        if control is not None:
            control.close()
        meter = current_meter.get()
        if meter is not None and meter.by_agent:
            # 失败或取消的任务同样花了 tokens，也要让用户看到。
            fields["result"] = {**(fields.get("result") or {}), "task_usage": meter.snapshot()}
        result = fields.get("result") or {}
        await self.storage.call(
            "update_task",
            task_id,
            {
                **fields,
                "status": status,
                "completed_at": now(),
                "question": None,
                "run_id": result.get("run_id"),
            },
        )
        await self.storage.call(
            "event", task_id, "TASK_FINISHED", {"task_id": task_id, "status": status}
        )
