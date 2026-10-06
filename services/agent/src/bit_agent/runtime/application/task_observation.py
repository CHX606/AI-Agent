from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime
from typing import Any

from bit_agent.observability.diagnostics import (
    failure,
    logging_available,
    record,
)
from bit_agent.runtime.application.interaction import (
    InteractionError,
)

from .service_protocol import (
    TERMINAL,
    now,
)


def _pending_operations(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    pending = {}
    for event in events:
        key = event.get("tool_call_id") or event.get("agent_id") or "main"
        if event["event"] in {"MODEL_REQUESTED", "TOOL_REQUESTED"}:
            pending[key] = event
        elif event["event"] in {"MODEL_RESPONDED", "TOOL_COMPLETED"}:
            pending.pop(key, None)
    return pending


def _active_phase(task: dict[str, Any], events: list[dict[str, Any]]) -> str:
    relevant = [e for e in events if e["task_id"] == task["task_id"]]
    pending = _pending_operations(relevant)
    if pending:
        task["phase_since"] = min(e.get("timestamp", now()) for e in pending.values())
    if relevant:
        task["last_activity"] = relevant[-1].get("timestamp")
    return (
        "tool"
        if any(e["event"] == "TOOL_REQUESTED" for e in pending.values())
        else "model"
        if pending
        else "processing"
    )


class TaskObservation:
    async def _observe_slow_tasks(self) -> None:
        while not self._closing:
            await asyncio.sleep(60)
            for task_id in list(self._running):
                try:
                    await self._observe_task_wait(task_id)
                except Exception as exc:
                    failure("diagnostic_observation_failed", exc, level="warn", task_id=task_id)

    async def _observe_task_wait(self, task_id: str) -> None:
        snapshot = await self.diagnostic_snapshot(task_id)
        for task in snapshot["tasks"]:
            since = datetime.fromisoformat(task["phase_since"])
            elapsed = max(0, int((datetime.now(UTC) - since).total_seconds() * 1000))
            if elapsed >= 60_000:
                record(
                    "info" if task["phase"] in {"paused", "approval", "user_input"} else "warn",
                    "task_wait_observed",
                    elapsed_ms=elapsed,
                    task_id=task_id,
                    session_id=task.get("session_id"),
                    phase=task["phase"],
                    phase_since=task["phase_since"],
                )

    async def get_task(self, task_id: str) -> dict[str, Any] | None:
        return await self.storage.call("get_task", task_id)

    def _task_phase(self, task: dict[str, Any], events: list[dict[str, Any]]) -> str:
        control = self._interactions.get(task["task_id"])
        if task["status"] == "QUEUED":
            return "execution_resource"
        if task["status"] == "WAITING_FOR_INPUT":
            return (
                "approval"
                if control and control.question and control.question.get("requires_confirmation")
                else "user_input"
            )
        if task["status"] == "PAUSED":
            return "paused"
        if task["status"] in TERMINAL:
            return "finished"
        if control and control.slot and not control.slot.owned and not control._waiting:
            return "execution_resource"
        return _active_phase(task, events)

    async def diagnostic_snapshot(self, task_id: str | None = None) -> dict[str, Any]:
        snapshot = await self.storage.call("diagnostic_snapshot", task_id)
        snapshot["available"] = logging_available()
        for task in snapshot["tasks"]:
            task["phase"] = self._task_phase(task, snapshot["events"])
        return snapshot

    async def interact_task(self, task_id: str, input: dict[str, Any]) -> dict[str, Any]:
        control = self._interactions.get(task_id)
        if control is None:
            task = await self.get_task(task_id)
            raise InteractionError(
                "任务不存在" if task is None else "任务已结束，请在同一对话发送下一条消息",
                404 if task is None else 409,
            )
        return await control.request(input)

    async def cancel_task(self, task_id: str) -> dict[str, Any]:
        task = await self.get_task(task_id)
        if task is None:
            return {"found": False, "changed": False, "task": None}
        if task["status"] in TERMINAL:
            return {"found": True, "changed": False, "task": task}
        status = "CANCELLED" if task["status"] == "QUEUED" else "CANCELLATION_REQUESTED"
        changes: dict[str, Any] = {"status": status}
        if status == "CANCELLED":
            changes["completed_at"] = now()
        task = await self.storage.call("update_task", task_id, changes)
        if task["status"] in TERMINAL and task["status"] != "CANCELLED":
            return {"found": True, "changed": False, "task": task}
        execution = self._running.get(task_id)
        if execution is not None:
            # 只取消一次，避免重复取消打断它保存最后状态的过程。
            if not execution.cancelling():
                execution.cancel()
        return {"found": True, "changed": True, "task": task}

    async def read_events(
        self, task_id: str, after_id: str = "0-0", block_ms: int = 1000
    ) -> list[dict[str, Any]]:
        if not isinstance(after_id, str) or not re.fullmatch(r"[0-9]+-0", after_id):
            raise ValueError("事件位置无效")
        after = int(after_id.split("-")[0])
        # 先记下版本再查询：查询之后才写入的事件也会让等待立即结束。
        since = self.storage.event_version
        events = await self.storage.call("read_events", task_id, after)
        if not events:
            task = await self.get_task(task_id)
            if task and task["status"] not in TERMINAL:
                await self.storage.wait_for_events(since, max(0, min(block_ms, 1000)) / 1000)
                events = await self.storage.call("read_events", task_id, after)
        return events
