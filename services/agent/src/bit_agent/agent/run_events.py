from __future__ import annotations

from typing import Any

from bit_agent.context.serialization import to_json_value
from bit_agent.memory import (
    WorkingMemoryStatus,
    WorkingMemoryTracker,
)
from bit_agent.observability import (
    AgentEventType,
)

from .run_protocol import (
    LONG_TERM_MEMORY_PREFIX,
)


class RunEvents:
    async def emit(self, event_type: AgentEventType, payload: dict[str, Any]) -> None:
        try:
            await self.event_bus.emit(
                event_type,
                run_id=self.run_id,
                agent_id=self.agent_id.strip(),
                task_id=self.task_id,
                payload=payload,
            )
        except Exception as exc:
            warning = f"EventBus: {type(exc).__name__}: {exc}"
            if warning not in self.event_warnings:
                self.event_warnings.append(warning)

    async def archive(self, items: list[Any]) -> None:
        if self.record_items is not None:
            await self.record_items(to_json_value(items))

    async def persist(self) -> None:
        memory = self.memory_tracker.memory
        self.verification.save_to(memory)
        memory.applied_interaction_ids = sorted(self.applied_interaction_ids)
        snapshot = self.memory_tracker.snapshot()
        if self.save_progress is not None:
            # 两份数据各存各的表，但一起成功或一起失败，避免恢复到不同进度。
            await self.save_progress({"history": to_json_value(self.conversation)}, snapshot)
            return
        try:
            await self.memory_store.save(snapshot, ttl_seconds=self.working_memory_ttl_seconds)
        except Exception as exc:
            warning = f"Working Memory 保存失败：{type(exc).__name__}: {exc}"
            if warning not in self.memory_warnings:
                self.memory_warnings.append(warning)

    async def restore(self) -> None:
        if self.restore_thread:
            await self._restore_memory()
        memory = self.memory_tracker.memory
        self.applied_interaction_ids.update(memory.applied_interaction_ids)
        self.verification.restore(
            memory,
            patch_interrupted=any(
                item.get("name") == "apply_patch" for item in self.interrupted_calls
            ),
        )
        self.context.restore_summary(self.conversation)
        self.state_ready = True
        await self.persist()
        await self.apply_intents(self.pending_intents)

    async def _restore_memory(self) -> None:
        try:
            restored = await self.memory_store.load(self.thread_id)
        except Exception as exc:
            if self.save_progress is not None:
                # 读取失败不能当作空会话继续保存，否则会覆盖原来的存档。
                raise
            self.memory_warnings.append(f"Working Memory 恢复失败：{type(exc).__name__}: {exc}")
            return
        if restored is None:
            return
        restored.status = WorkingMemoryStatus.ACTIVE
        if self.working_memory_objective is not None:
            restored.objective = self.working_memory_objective.strip()
        self.memory_tracker = WorkingMemoryTracker(restored)

    async def recall_long_term_memory(self) -> None:
        if self.memory_retriever is None:
            return
        try:
            memory_context = await self.memory_retriever.build_context(
                self.prompt, project_id=self.memory_project_id, user_id=self.memory_user_id
            )
        except Exception as exc:
            self.memory_warnings.append(f"长期记忆召回失败：{type(exc).__name__}: {exc}")
            return
        if not memory_context.text:
            return
        self.conversation.append(
            {"role": "developer", "content": LONG_TERM_MEMORY_PREFIX + memory_context.text}
        )
        self.recalled_memory_ids = [match.memory.id for match in memory_context.matches]
        self.memory_context_tokens = memory_context.estimated_tokens
        await self.emit(
            AgentEventType.MEMORY_RECALLED,
            {
                "memory_count": len(self.recalled_memory_ids),
                "estimated_tokens": self.memory_context_tokens,
            },
        )
