"""上下文、工作记忆和用户输入消费在同一事务保存。"""

import json
from datetime import UTC, datetime
from typing import Any

from bit_agent.memory.models import TestStatus, WorkingMemory


class ContextRecords:
    def _save_progress(
        self, session_id: str, context: dict[str, Any], memory: WorkingMemory
    ) -> None:
        """上下文、任务状态各写一次；由 _call 的同一次事务保证同时落盘。"""
        if memory.thread_id != session_id:
            raise ValueError("上下文与任务状态必须属于同一个会话")
        if set(context) != {"history"} or not isinstance(context["history"], list):
            raise ValueError("context_state 只保存上下文历史，不能夹带任务状态")
        self._db.execute(
            "INSERT OR REPLACE INTO context_state VALUES (?, ?)",
            (session_id, json.dumps(context, ensure_ascii=False)),
        )
        self._save_memory(memory)
        self._acknowledge_answers(session_id, context["history"], memory)

    def _acknowledge_answers(
        self, session_id: str, history: list[Any], memory: WorkingMemory
    ) -> None:
        pending = self._db.execute(
            "SELECT a.question_id, a.data FROM user_answers a JOIN tasks t ON t.id=a.task_id "
            "WHERE t.session_id=? AND a.applied=0",
            (session_id,),
        ).fetchall()
        if not pending:
            return
        applied = set(memory.applied_interaction_ids)
        answered = set()
        for item in history:
            if not isinstance(item, dict) or item.get("type") != "function_call_output":
                continue
            try:
                result = json.loads(item.get("output", ""))
            except (ValueError, TypeError):
                continue
            if (
                isinstance(result, dict)
                and result.get("tool_name") == "ask_user"
                and result.get("status") == "SUCCESS"
                and isinstance(result.get("output"), dict)
                and result["output"].get("source") == "user"
                and isinstance(result["output"].get("question_id"), str)
            ):
                answered.add(result["output"]["question_id"])
        # 工具结果或恢复后的输入与确认消费一起落盘，之后压缩历史也不会重复回放。
        self._db.executemany(
            "UPDATE user_answers SET applied=1 WHERE question_id=?",
            [
                (row["question_id"],)
                for row in pending
                if self._answer_applied(row, answered, applied)
            ],
        )

    def _load_context(self, session_id: str) -> dict[str, Any]:
        self._migrate_session(session_id)
        row = self._db.execute(
            "SELECT data FROM context_state WHERE session_id=?",
            (session_id,),
        ).fetchone()
        return json.loads(row["data"]) if row else {"history": []}

    def _pending_intents(self, session_id: str) -> list[dict[str, Any]]:
        memory = self._load_memory(session_id)
        applied = set(memory.applied_interaction_ids) if memory else set()
        rows = self._db.execute(
            "SELECT data FROM tasks WHERE session_id=? ORDER BY created_at, rowid",
            (session_id,),
        ).fetchall()
        # 用户要求先落盘。即使刚提交就关闭程序，下次续聊也不会漏掉它。
        return [
            update
            for task in rows
            for update in self._task_inputs(json.loads(task["data"]), pending_answers_only=True)
            if update["id"] not in applied
        ]

    def _acceptance_context(self, session_id: str) -> dict[str, Any]:
        """User-authored requirements only; never inherit the author's conclusions."""
        rows = self._db.execute(
            "SELECT data FROM tasks WHERE session_id=? ORDER BY created_at, rowid",
            (session_id,),
        ).fetchall()
        requirements = []
        for row in rows:
            task = json.loads(row["data"])
            requirements.append(
                {
                    "task_id": task["task_id"],
                    "objective": task["objective"],
                    "updates": self._task_inputs(task),
                    **({"images": task["images"]} if task.get("images") else {}),
                    **({"attachments": task["attachments"]} if task.get("attachments") else {}),
                }
            )
        return {"user_requests": requirements}

    def _record_undo(self, session_id: str, paths: list[str], objective: str) -> None:
        context = self._load_context(session_id)
        memory = self._load_memory(session_id) or WorkingMemory(
            thread_id=session_id, objective=objective
        )
        context["history"].append(
            {
                "role": "user",
                "content": "用户已撤销改动。请重新读取文件，不能假定旧补丁仍存在。",
            }
        )
        memory.has_unverified_changes = True
        memory.basic_checks_passed = False
        memory.acceptance_status = "NOT_RUN"
        memory.verification_paths = sorted(set(memory.verification_paths) | set(paths))
        memory.changed_files = sorted(set(memory.changed_files) | set(paths))
        memory.latest_test_status = TestStatus.NEEDS_VERIFICATION
        memory.updated_at = datetime.now(UTC)
        self._save_progress(session_id, context, memory)

    def _save_memory(self, memory: WorkingMemory) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO working_memory VALUES (?, ?)",
            (memory.thread_id, memory.model_dump_json()),
        )

    def _load_memory(self, thread_id: str) -> WorkingMemory | None:
        self._migrate_session(thread_id)
        row = self._db.execute(
            "SELECT data FROM working_memory WHERE thread_id=?",
            (thread_id,),
        ).fetchone()
        return WorkingMemory.model_validate_json(row["data"]) if row else None

    def _delete_memory(self, thread_id: str) -> None:
        self._db.execute("DELETE FROM working_memory WHERE thread_id=?", (thread_id,))

    def _answer_applied(self, row: Any, answered: set[str], applied: set[str]) -> bool:
        update = json.loads(row["data"])
        return update["id"] in applied or (
            not update.get("images")
            and not update.get("attachments")
            and row["question_id"] in answered
        )
