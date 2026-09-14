"""上层只通过 AgentRuntime 创建任务、继续对话、查看进度和取消执行。"""

import asyncio
import os
import re
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from bit_agent.agent.limits import DEFAULT_MAX_TOOL_ROUNDS, validate_max_tool_rounds
from bit_agent.agent.runtime import run_agent
from bit_agent.memory import WorkingMemoryStore
from bit_agent.memory.models import WorkingMemory
from bit_agent.observability import AgentEvent
from bit_agent.observability.diagnostics import (
    diagnostic_context,
    failure,
    logging_available,
    public_error,
    record,
)
from bit_agent.runtime.application.capacity import ExecutionSlot, WorkspaceReservations
from bit_agent.runtime.application.delegation import MODE_INSTRUCTIONS, DelegatingToolProvider
from bit_agent.runtime.application.interaction import (
    INTERACTION_INSTRUCTIONS,
    InteractionError,
    TaskInteraction,
)
from bit_agent.runtime.application.ports import (
    AcceptanceWorkspaceFactory,
    JournalFactory,
    ProjectVerifier,
    StoragePort,
)

TERMINAL = {"COMPLETED", "PARTIAL", "FAILED", "CANCELLED"}


def now() -> str:
    return datetime.now(UTC).isoformat()


class TaskEventSink:
    def __init__(self, storage: StoragePort, task_id: str) -> None:
        self.storage = storage
        self.task_id = task_id

    async def emit(self, event: AgentEvent) -> None:
        data = event.model_dump(mode="json")
        data["task_id"] = self.task_id
        await self.storage.call("event", self.task_id, event.event_type, data)


class AgentRuntime:
    """管理本机的会话和执行进程，不需要 Redis 或 PostgreSQL 服务。"""

    def __init__(
        self,
        *,
        concurrency: int = 2,
        storage: StoragePort,
        memory: WorkingMemoryStore,
        journal_factory: JournalFactory,
        verifier: ProjectVerifier,
        acceptance_workspace: AcceptanceWorkspaceFactory | None = None,
    ) -> None:
        if concurrency < 1:
            raise ValueError("并发数量必须大于 0")
        self.storage = storage
        self.memory = memory
        self.journal_factory = journal_factory
        self.verifier = verifier
        self.acceptance_workspace = acceptance_workspace
        self._slots = asyncio.Semaphore(concurrency)
        self._workspaces = WorkspaceReservations()
        self._running: dict[str, asyncio.Task[None]] = {}
        self._interactions: dict[str, TaskInteraction] = {}
        self._sessions: dict[str, str] = {}
        self._submission_lock = asyncio.Lock()
        self._closing = False
        self._diagnostic_monitor: asyncio.Task[None] | None = None

    async def start(self) -> None:
        await self.storage.call("recover")
        self._diagnostic_monitor = asyncio.create_task(self._observe_slow_tasks())

    async def _observe_slow_tasks(self) -> None:
        # Read the existing records. Observation never advances or cancels a task.
        while not self._closing:
            await asyncio.sleep(60)
            for task_id in list(self._running):
                try:
                    snapshot = await self.diagnostic_snapshot(task_id)
                    for task in snapshot["tasks"]:
                        since = datetime.fromisoformat(task["phase_since"])
                        elapsed = max(0, int((datetime.now(UTC) - since).total_seconds() * 1000))
                        if elapsed >= 60_000:
                            record("info" if task["phase"] in {"paused", "approval", "user_input"}
                                   else "warn", "task_wait_observed", elapsed_ms=elapsed,
                                   task_id=task_id, session_id=task.get("session_id"),
                                   phase=task["phase"], phase_since=task["phase_since"])
                except Exception as exc:
                    failure("diagnostic_observation_failed", exc, level="warn", task_id=task_id)

    async def create_task(self, input: dict[str, Any]) -> dict[str, Any]:
        objective = input.get("objective", "")
        workspace = input.get("workspace_root", "")
        mode = input.get("multi_agent_mode", "auto")
        permission = input.get("permission_mode", "confirm")
        max_tool_rounds = validate_max_tool_rounds(
            input.get("max_tool_rounds", DEFAULT_MAX_TOOL_ROUNDS)
        )
        if permission not in {"read_only", "confirm", "edit"}:
            raise ValueError("权限模式无效")
        if not isinstance(objective, str) or not 1 <= len(objective.strip()) <= 4000:
            raise ValueError("请填写 1 到 4000 个字符的任务要求")
        if not isinstance(workspace, str) or not Path(workspace).is_absolute():
            raise ValueError("工作区必须是绝对路径")
        root = Path(workspace).resolve()
        if not root.is_dir():
            raise ValueError("工作区不存在或不是目录")
        if mode not in MODE_INSTRUCTIONS:
            raise ValueError("多 Agent 模式只能是 off、on 或 auto")
        requested_session = input.get("session_id")
        session_id = requested_session or uuid4().hex
        if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
            raise ValueError("会话编号无效")

        async with self._submission_lock:
            if self._closing:
                raise ValueError("运行服务正在关闭")
            if len(self._running) >= 100:
                raise ValueError("待执行任务过多，请等待已有任务完成")
            if session_id in self._sessions:
                raise ValueError("这个对话还在执行，请先等待完成或取消；可以另开对话")
            previous = await self.storage.call("session", session_id)
            if requested_session and previous is None:
                raise ValueError("会话不存在，请新建对话")
            if previous and os.path.normcase(previous["workspace_root"]) != os.path.normcase(
                str(root)
            ):
                raise ValueError("已有对话不能更换工作区，请新建对话")
            timestamp = now()
            task = {
                "task_id": uuid4().hex,
                "session_id": session_id,
                "multi_agent_mode": mode,
                "permission_mode": permission,
                "max_tool_rounds": max_tool_rounds,
                "objective": objective.strip(),
                "workspace_root": str(root),
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
            self._interactions[task["task_id"]] = TaskInteraction(self.storage, task["task_id"])
            self._sessions[session_id] = task["task_id"]
            execution = asyncio.create_task(self._execute(task))
            self._running[task["task_id"]] = execution

            def release(_finished: asyncio.Task[None]) -> None:
                if not _finished.cancelled() and (error := _finished.exception()) is not None:
                    failure(
                        "task_finalization_failed",
                        error,
                        task_id=task["task_id"],
                        session_id=session_id,
                    )
                # 连第一行都没开始就取消时，协程的 finally 不会执行，由这里兜底。
                self._running.pop(task["task_id"], None)
                control = self._interactions.pop(task["task_id"], None)
                if control is not None:
                    control.close()
                if self._sessions.get(session_id) == task["task_id"]:
                    self._sessions.pop(session_id, None)

            execution.add_done_callback(release)
            return task

    async def _execute(self, task: dict[str, Any]) -> None:
        with diagnostic_context(task_id=task["task_id"], session_id=task["session_id"]):
            await self._execute_task(task)

    async def _execute_task(self, task: dict[str, Any]) -> None:
        task_id, session_id = task["task_id"], task["session_id"]
        root = Path(task["workspace_root"])
        sink = TaskEventSink(self.storage, task_id)
        control = self._interactions[task_id]

        async def save_progress(context: dict[str, Any], memory: WorkingMemory) -> None:
            await self.storage.call("save_progress", session_id, context, memory)

        async def record_items(items: list[Any]) -> None:
            await self.storage.call("append_items", task_id, items)

        try:
            # 父子工作区也可能写同一文件；等待用户时继续保留目录预约。
            async with self._workspaces.hold(root), ExecutionSlot(self._slots) as slot:
                control.slot = slot
                current = await self.get_task(task_id)
                if current is None or current["status"] in {"CANCELLED", "CANCELLATION_REQUESTED"}:
                    await self._finish(task_id, "CANCELLED")
                    return
                await self.storage.call(
                    "update_task", task_id, {"status": "RUNNING", "started_at": now()}
                )
                state = await self.storage.call("load_context", session_id)
                memory = await self.memory.load(session_id)
                pending_intents = await self.storage.call("pending_intents", session_id)
                artifacts = self.storage.directory / "artifacts" / task_id

                async def acceptance_context():
                    return await self.storage.call("acceptance_context", session_id)

                provider = DelegatingToolProvider(
                    root,
                    task["multi_agent_mode"],
                    sink,
                    artifacts,
                    control,
                    permission_mode=task.get("permission_mode", "confirm"),
                    inherited_changes=memory.verification_paths if memory else [],
                    journal=self.journal_factory(root, artifacts),
                    verifier=self.verifier,
                    acceptance_workspace=self.acceptance_workspace,
                    acceptance_context=acceptance_context,
                    max_tool_rounds=task.get("max_tool_rounds", DEFAULT_MAX_TOOL_ROUNDS),
                )
                timeout = float(os.getenv("BIT_AGENT_TASK_TIMEOUT_SECONDS", "3600"))
                if timeout <= 0:
                    raise ValueError("任务超时必须大于 0")
                async with asyncio.timeout(timeout) as deadline:
                    control.deadline = deadline
                    result = await run_agent(
                        task["objective"],
                        workspace_root=root,
                        max_tool_rounds=task.get("max_tool_rounds", DEFAULT_MAX_TOOL_ROUNDS),
                        thread_id=session_id,
                        working_memory_store=self.memory,
                        initial_state=state,
                        save_progress=save_progress,
                        pending_intents=pending_intents,
                        record_items=record_items,
                        runtime_instructions=(
                            MODE_INSTRUCTIONS[task["multi_agent_mode"]]
                            + INTERACTION_INSTRUCTIONS
                            + "修改文件后必须调用 verify_project 完成基础检查。"
                            + ("基础通过后调用 verify_task 独立验收；两者通过才可宣称完成。"
                               if self.acceptance_workspace else "")
                            + f"本轮权限模式：{task.get('permission_mode', 'confirm')}。"
                        ),
                        interaction=control.boundary,
                        require_independent_acceptance=self.acceptance_workspace is not None,
                        tool_provider=provider,
                        event_sink=sink,
                        task_id=task_id,
                        context_artifact_directory=artifacts / "main",
                    )
                current = await self.get_task(task_id)
                status = (
                    "CANCELLED"
                    if current and current["status"] == "CANCELLATION_REQUESTED"
                    else result.status
                )
                await self._finish(
                    task_id, status, result=result.model_dump(mode="json"), error=result.error
                )
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

    async def _finish(self, task_id: str, status: str, **fields: Any) -> None:
        control = self._interactions.get(task_id)
        if control is not None:
            control.close()
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

    async def get_task(self, task_id: str) -> dict[str, Any] | None:
        return await self.storage.call("get_task", task_id)

    async def diagnostic_snapshot(self, task_id: str | None = None) -> dict[str, Any]:
        snapshot = await self.storage.call("diagnostic_snapshot", task_id)
        snapshot["available"] = logging_available()
        for task in snapshot["tasks"]:
            control = self._interactions.get(task["task_id"])
            if task["status"] == "QUEUED":
                phase = "execution_resource"
            elif task["status"] == "WAITING_FOR_INPUT":
                phase = (
                    "approval"
                    if control
                    and control.question
                    and control.question.get("requires_confirmation")
                    else "user_input"
                )
            elif task["status"] == "PAUSED":
                phase = "paused"
            elif task["status"] in TERMINAL:
                phase = "finished"
            elif control and control.slot and not control.slot.owned and not control._waiting:
                phase = "execution_resource"
            else:
                relevant = [e for e in snapshot["events"] if e["task_id"] == task["task_id"]]
                pending = {}
                for event in relevant:
                    key = event.get("tool_call_id") or event.get("agent_id") or "main"
                    if event["event"] in {"MODEL_REQUESTED", "TOOL_REQUESTED"}:
                        pending[key] = event
                    elif event["event"] in {"MODEL_RESPONDED", "TOOL_COMPLETED"}:
                        pending.pop(key, None)
                phase = (
                    "tool"
                    if any(e["event"] == "TOOL_REQUESTED" for e in pending.values())
                    else "model"
                    if pending
                    else "processing"
                )
                if pending:
                    task["phase_since"] = min(e.get("timestamp", now()) for e in pending.values())
                if relevant:
                    task["last_activity"] = relevant[-1].get("timestamp")
            task["phase"] = phase
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
        events = await self.storage.call("read_events", task_id, after)
        if not events:
            task = await self.get_task(task_id)
            if task and task["status"] not in TERMINAL:
                await asyncio.sleep(max(0, min(block_ms, 1000)) / 1000)
                events = await self.storage.call("read_events", task_id, after)
        return events

    async def list_sessions(self, limit: int = 200, offset: int = 0) -> dict[str, Any]:
        return await self.storage.call(
            "list_sessions", max(1, min(int(limit), 200)), max(0, int(offset))
        )

    async def get_session(self, session_id: str) -> dict[str, Any] | None:
        return await self.storage.call("get_session", session_id)

    async def set_mode(self, session_id: str, mode: str) -> dict[str, Any] | None:
        if mode not in MODE_INSTRUCTIONS:
            raise ValueError("多 Agent 模式无效")
        return await self.storage.call("set_mode", session_id, mode)

    async def get_changes(self, task_id: str) -> dict[str, Any]:
        task = await self.get_task(task_id)
        if task is None:
            raise InteractionError("任务不存在", 404)
        return self.journal_factory(
            Path(task["workspace_root"]), self.storage.directory / "artifacts" / task_id
        ).public()

    async def review_change(self, task_id: str, change_id: str, action: str) -> dict[str, Any]:
        task = await self.get_task(task_id)
        if task is None:
            raise InteractionError("任务不存在", 404)
        if task["status"] not in TERMINAL:
            raise InteractionError("请先结束任务，再保留或撤销改动")
        root = Path(task["workspace_root"])
        async with self._workspaces.hold(root, wait=False):
            journal = self.journal_factory(root, self.storage.directory / "artifacts" / task_id)
            result = journal.review(change_id, action)
            if action == "undo":
                await self.storage.call(
                    "record_undo",
                    task["session_id"],
                    sorted({name for entry in journal.entries for name in entry["files"]}),
                    task["objective"],
                )
            await self.storage.call(
                "event",
                task_id,
                "CHANGE_REVIEWED",
                {
                    "task_id": task_id,
                    "change_id": change_id,
                    "action": action,
                },
            )
            return result

    async def configure_model(self, input: dict[str, Any]) -> dict[str, Any]:
        from urllib.parse import urlparse

        url = input.get("base_url", "")
        model = input.get("model", "")
        key = input.get("api_key", "")
        if not all(isinstance(value, str) and value.strip() for value in (url, model, key)):
            raise ValueError("模型地址、模型名和密钥不能为空")
        parsed = urlparse(url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("模型地址不能夹带用户名、密钥或查询参数")
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            raise ValueError("远程模型必须使用 HTTPS，本地模型允许 HTTP")
        os.environ.update(API_KEY=key, BASE_URL=url, MODEL_NAME=model)
        return {"configured": True, "model": model, "base_url": url}

    async def close(self) -> None:
        self._closing = True
        if self._diagnostic_monitor is not None:
            self._diagnostic_monitor.cancel()
            with suppress(asyncio.CancelledError):
                await self._diagnostic_monitor
        executions = list(self._running.values())
        for execution in executions:
            if not execution.cancelling():
                execution.cancel()
        await asyncio.gather(*executions, return_exceptions=True)
        await asyncio.to_thread(self.storage.close)
