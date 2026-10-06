from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from bit_agent.agent.limits import DEFAULT_MAX_TOOL_ROUNDS, validate_max_tool_rounds
from bit_agent.agent.runtime import REASONING_EFFORTS
from bit_agent.images import validate_images
from bit_agent.observability.diagnostics import failure
from bit_agent.runtime.application.delegation import MODE_INSTRUCTIONS
from bit_agent.runtime.application.interaction import TaskInteraction
from bit_agent.runtime.domain.acceptance_policy import ACCEPTANCE_MODES, DEFAULT_ACCEPTANCE_MODE

from .service_protocol import now


def _model_options(input: dict[str, Any]) -> dict[str, Any]:
    model, effort = input.get("model"), input.get("reasoning_effort")
    if model is not None and (
        not isinstance(model, str) or not re.fullmatch(r"[\w.:/@+\-]{1,200}", model)
    ):
        raise ValueError("模型名称无效")
    if effort is not None and effort not in REASONING_EFFORTS:
        raise ValueError("思考程度无效")
    return {
        **({"model": model} if model else {}),
        **({"reasoning_effort": effort} if effort else {}),
    }


def _workspace_root(workspace: Any) -> Path:
    if not isinstance(workspace, str) or not Path(workspace).is_absolute():
        raise ValueError("工作区必须是绝对路径")
    root = Path(workspace).resolve()
    if not root.is_dir():
        raise ValueError("工作区不存在或不是目录")
    return root


def _task_input(input: dict[str, Any]) -> dict[str, Any]:
    objective = input.get("objective", "")
    images = validate_images(input.get("images"))
    if (
        not isinstance(objective, str)
        or len(objective.strip()) > 4000
        or not (objective.strip() or images)
    ):
        raise ValueError("请填写 1 到 4000 个字符的任务要求，或上传图片")
    root = _workspace_root(input.get("workspace_root", ""))
    mode, permission = (
        input.get("multi_agent_mode", "auto"),
        input.get("permission_mode", "confirm"),
    )
    if permission not in {"read_only", "confirm", "edit"}:
        raise ValueError("权限模式无效")
    acceptance_mode = input.get("acceptance_mode", DEFAULT_ACCEPTANCE_MODE)
    if acceptance_mode not in ACCEPTANCE_MODES:
        raise ValueError("独立验收设置只能是 auto、always 或 off")
    if mode not in MODE_INSTRUCTIONS:
        raise ValueError("多 Agent 模式只能是 off、on 或 auto")
    session_id = input.get("session_id") or uuid4().hex
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
        raise ValueError("会话编号无效")
    return {
        "objective": objective.strip(),
        "workspace_root": str(root),
        "session_id": session_id,
        "multi_agent_mode": mode,
        "permission_mode": permission,
        "acceptance_mode": acceptance_mode,
        "max_tool_rounds": validate_max_tool_rounds(
            input.get("max_tool_rounds", DEFAULT_MAX_TOOL_ROUNDS)
        ),
        **_model_options(input),
        **({"images": images} if images else {}),
    }


class TaskSubmission:
    async def create_task(self, input: dict[str, Any]) -> dict[str, Any]:
        fields = _task_input(input)
        async with self._submission_lock:
            await self._check_submission(fields, bool(input.get("session_id")))
            timestamp = now()
            task = {
                **fields,
                "task_id": uuid4().hex,
                "status": "QUEUED",
                "created_at": timestamp,
                "updated_at": timestamp,
                "started_at": None,
                "completed_at": None,
                "worker_id": "local",
                "run_id": None,
                "result": None,
                "error": None,
            }
            await self.storage.call("create", task)
            self._schedule_task(task)
            return task

    async def _check_submission(self, fields: dict[str, Any], requested_session: bool) -> None:
        if self._closing:
            raise ValueError("运行服务正在关闭")
        if len(self._running) >= 100:
            raise ValueError("待执行任务过多，请等待已有任务完成")
        session_id = fields["session_id"]
        if session_id in self._sessions:
            raise ValueError("这个对话还在执行，请先等待完成或取消；可以另开对话")
        previous = await self.storage.call("session", session_id)
        if requested_session and previous is None:
            raise ValueError("会话不存在，请新建对话")
        if previous and os.path.normcase(previous["workspace_root"]) != os.path.normcase(
            fields["workspace_root"]
        ):
            raise ValueError("已有对话不能更换工作区，请新建对话")

    def _schedule_task(self, task: dict[str, Any]) -> None:
        task_id, session_id = task["task_id"], task["session_id"]
        self._interactions[task_id] = TaskInteraction(self.storage, task_id)
        self._sessions[session_id] = task_id
        execution = asyncio.create_task(self._execute(task))
        self._running[task_id] = execution
        execution.add_done_callback(
            lambda finished: self._release_task(finished, task_id, session_id)
        )

    def _release_task(self, finished: asyncio.Task[None], task_id: str, session_id: str) -> None:
        if not finished.cancelled() and (error := finished.exception()) is not None:
            failure("task_finalization_failed", error, task_id=task_id, session_id=session_id)
        # 连第一行都没开始就取消时，协程的 finally 不会执行，由这里兜底。
        self._running.pop(task_id, None)
        control = self._interactions.pop(task_id, None)
        if control is not None:
            control.close()
        if self._sessions.get(session_id) == task_id:
            self._sessions.pop(session_id, None)
