from __future__ import annotations

import asyncio
from typing import Any

from bit_agent.observability.diagnostics import (
    diagnostic_context,
    failure,
    record,
)
from bit_agent.runtime.application.delegation import (
    MODE_INSTRUCTIONS,
)
from bit_agent.runtime.application.interaction import (
    InteractionError,
)


class SessionCommands:
    def _learn_later(self, task: dict[str, Any], result: Any, patches: list[str]) -> None:
        if self.long_term_memory is None or self._closing:
            return
        job = asyncio.create_task(self._learn(task, result, patches))
        self._background.add(job)
        job.add_done_callback(self._background.discard)

    async def _learn(self, task: dict[str, Any], result: Any, patches: list[str]) -> None:
        assert self.long_term_memory is not None
        with diagnostic_context(task_id=task["task_id"], session_id=task["session_id"]):
            try:
                outcome = await self.long_term_memory.learn(task, result, patches)
            except Exception as exc:
                failure("memory_consolidation_failed", exc, level="warn")
                return
            if outcome is None:
                return
            record(
                "info" if outcome.error is None else "warn",
                "memory_consolidated",
                status=str(outcome.status),
                count=len(outcome.created) + len(outcome.updated),
                error_type=outcome.error.split(":", 1)[0] if outcome.error else None,
            )

    async def list_memories(self, workspace_root: str | None = None) -> dict[str, Any]:
        if self.long_term_memory is None:
            return {"enabled": False, "memories": []}
        return {
            "enabled": True,
            "memories": await self.long_term_memory.list_memories(workspace_root),
        }

    async def delete_memory(self, memory_id: str) -> dict[str, Any]:
        if self.long_term_memory is None or not await self.long_term_memory.delete(memory_id):
            raise InteractionError("记忆不存在或已删除", 404)
        return {"deleted": True, "memory_id": memory_id}

    async def list_sessions(
        self, limit: int = 200, offset: int = 0, query: str = ""
    ) -> dict[str, Any]:
        if not isinstance(query, str) or len(query) > 200:
            raise ValueError("搜索词最多 200 个字符")
        return await self.storage.call(
            "list_sessions", max(1, min(int(limit), 200)), max(0, int(offset)), query.strip()
        )

    async def rename_session(self, session_id: str, title: str) -> dict[str, Any]:
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 100:
            raise InteractionError("对话名称需要 1 到 100 个字符", 400)
        session = await self.storage.call("rename_session", session_id, title.strip())
        if session is None:
            raise InteractionError("对话不存在", 404)
        return session

    async def delete_session(self, session_id: str) -> dict[str, Any]:
        """删除对话、所有轮次的记录和改动快照。项目文件和长期记忆不受影响。"""
        async with self._submission_lock:
            if session_id in self._sessions:
                raise InteractionError("这个对话还在执行，请先停止再删除")
            if await self.storage.call("session", session_id) is None:
                raise InteractionError("对话不存在", 404)
            task_ids = await self.storage.call("delete_session", session_id)
            self._session_approvals.pop(session_id, None)
        await self.storage.call("remove_artifacts", task_ids)
        return {"deleted": True, "session_id": session_id, "tasks": len(task_ids)}

    async def get_session(self, session_id: str) -> dict[str, Any] | None:
        return await self.storage.call("get_session", session_id)

    async def set_mode(self, session_id: str, mode: str) -> dict[str, Any] | None:
        if mode not in MODE_INSTRUCTIONS:
            raise ValueError("多 Agent 模式无效")
        return await self.storage.call("set_mode", session_id, mode)
