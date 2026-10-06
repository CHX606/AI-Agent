"""首次读取时迁移旧上下文格式，失败保留原始数据库记录。"""

import json
from typing import Any

from bit_agent.context.manager import CONTEXT_SUMMARY_PREFIX
from bit_agent.memory.models import TestStatus, WorkingMemory


class LegacySessions:
    def _migrate_session(self, session_id: str) -> None:
        context_row = self._db.execute(
            "SELECT data FROM context_state WHERE session_id=?", (session_id,)
        ).fetchone()
        memory_row = self._db.execute(
            "SELECT data FROM working_memory WHERE thread_id=?", (session_id,)
        ).fetchone()
        old_context = json.loads(context_row["data"]) if context_row else {}
        old_memory = json.loads(memory_row["data"]) if memory_row else {}
        if not (set(old_context) - {"history"} or "history_summary" in old_memory):
            return
        history = old_context.get("history", [])
        self._restore_legacy_summary(history, old_memory.pop("history_summary", None))
        intent = old_context.get("intent_state") or {}
        memory = WorkingMemory.model_validate(old_memory or self._legacy_memory(session_id, intent))
        self._merge_legacy_verification(old_context, memory)
        if not intent or all(
            intent.get(field, getattr(memory, field)) == getattr(memory, field)
            for field in ("objective", "constraints", "current_plan")
        ):
            memory.applied_interaction_ids = list(
                dict.fromkeys(
                    [
                        *memory.applied_interaction_ids,
                        *old_context.get("applied_interaction_ids", []),
                    ]
                )
            )
        self._save_progress(session_id, {"history": history}, memory)

    def _restore_legacy_summary(self, history: list[Any], summary: str | None) -> None:
        if summary and not any(
            isinstance(item, dict)
            and item.get("role") == "developer"
            and str(item.get("content", "")).startswith(CONTEXT_SUMMARY_PREFIX)
            for item in history
        ):
            history.insert(
                0,
                {
                    "role": "developer",
                    "content": CONTEXT_SUMMARY_PREFIX + "\n" + summary,
                },
            )

    def _legacy_memory(self, session_id: str, intent: dict[str, Any]) -> dict[str, Any]:
        first_task = self._db.execute(
            "SELECT data FROM tasks WHERE session_id=? ORDER BY created_at, rowid LIMIT 1",
            (session_id,),
        ).fetchone()
        objective = intent.get("objective") or (
            json.loads(first_task["data"])["objective"] if first_task else None
        )
        if not objective:
            raise ValueError("旧存档缺少任务目标，已保留原记录，没有用空状态覆盖")
        return {
            "thread_id": session_id,
            "objective": objective,
            "constraints": intent.get("constraints", []),
            "current_plan": intent.get("current_plan", []),
        }

    def _merge_legacy_verification(
        self, old_context: dict[str, Any], memory: WorkingMemory
    ) -> None:
        memory.has_unverified_changes = old_context.get(
            "has_unverified_changes",
            memory.has_unverified_changes
            or memory.latest_test_status == TestStatus.NEEDS_VERIFICATION,
        )
        paths = list(dict.fromkeys(old_context.get("changed_files", memory.changed_files)))
        memory.verification_paths = paths if memory.has_unverified_changes else []
        memory.changed_files = list(dict.fromkeys([*memory.changed_files, *paths]))
