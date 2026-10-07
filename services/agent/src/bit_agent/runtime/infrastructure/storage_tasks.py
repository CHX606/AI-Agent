"""持久化任务及等待恢复的用户输入。"""

import json
from typing import Any

from bit_agent.images import readable_objective
from bit_agent.observability.diagnostics import failure, public_error
from bit_agent.runtime.domain.clock import accepted_at
from bit_agent.runtime.infrastructure.storage_database import now


class TaskRecords:
    def _create(self, task: dict[str, Any]) -> None:
        session_id = task["session_id"]
        existing = self._session(session_id)
        if existing is None:
            self._db.execute(
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    task["workspace_root"],
                    readable_objective(task["objective"], task.get("attachments"))[:100],
                    task["multi_agent_mode"],
                    task["created_at"],
                    task["created_at"],
                ),
            )
        self._db.execute(
            "UPDATE sessions SET mode=?, updated_at=? WHERE id=?",
            (task["multi_agent_mode"], task["created_at"], session_id),
        )
        self._db.execute(
            "INSERT INTO tasks VALUES (?, ?, ?, ?, ?)",
            (
                task["task_id"],
                session_id,
                task["status"],
                task["created_at"],
                json.dumps(task, ensure_ascii=False),
            ),
        )

    def _get_task(self, task_id: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT data FROM tasks WHERE id=?", (task_id,)).fetchone()
        return json.loads(row["data"]) if row else None

    def _update_task(self, task_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        task = self._get_task(task_id)
        if task is None:
            raise ValueError("任务不存在")
        if task["status"] in {"COMPLETED", "PARTIAL", "FAILED", "CANCELLED"}:
            return task
        if task["status"] == "CANCELLATION_REQUESTED" and changes.get("status") in {
            "RUNNING",
            "QUEUED",
            "PAUSE_REQUESTED",
            "PAUSED",
            "WAITING_FOR_INPUT",
        }:
            return task
        task.update(changes, updated_at=now())
        self._db.execute(
            "UPDATE tasks SET status=?, data=? WHERE id=?",
            (task["status"], json.dumps(task, ensure_ascii=False), task_id),
        )
        self._db.execute(
            "UPDATE sessions SET updated_at=? WHERE id=?",
            (task["updated_at"], task["session_id"]),
        )
        return task

    def _answer_task(
        self, task_id: str, changes: dict[str, Any], question: dict[str, Any]
    ) -> dict[str, Any]:
        """确认接收回答与保存待恢复输入属于同一次事务。"""
        task = self._update_task(task_id, changes)
        answer = changes["last_answer"]
        if (
            task["status"] == "RUNNING"
            and task.get("last_answer") == answer
            and (
                answer.get("images")
                or answer.get("attachments")
                or (not question.get("requires_confirmation") and "operation" not in question)
            )
            and answer.get("source") == "user"
        ):
            update = {
                "id": "answer_" + question["id"],
                "kind": "supplement",
                "text": f"用户对问题「{question['question']}」的回答：{answer['text']}",
                "accepted_at": accepted_at(),
                **({"images": answer["images"]} if answer.get("images") else {}),
                **({"attachments": answer["attachments"]} if answer.get("attachments") else {}),
            }
            self._db.execute(
                "INSERT OR IGNORE INTO user_answers(question_id, task_id, data) VALUES (?, ?, ?)",
                (question["id"], task_id, json.dumps(update, ensure_ascii=False)),
            )
        return task

    def _task_inputs(
        self, task: dict[str, Any], *, pending_answers_only: bool = False
    ) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT data FROM user_answers WHERE task_id=?"
            + (" AND applied=0" if pending_answers_only else "")
            + " ORDER BY rowid",
            (task["task_id"],),
        ).fetchall()
        return sorted(
            [*task.get("intent_updates", []), *(json.loads(row["data"]) for row in rows)],
            key=lambda update: update.get("accepted_at", task["created_at"]),
        )

    def _recover(self) -> None:
        # 崩溃前可能已经改了文件，不能把旧任务悄悄再跑一次。
        rows = self._db.execute(
            "SELECT id FROM tasks WHERE status IN "
            "('QUEUED','RUNNING','CANCELLATION_REQUESTED','PAUSE_REQUESTED','PAUSED','WAITING_FOR_INPUT')",
        ).fetchall()
        for row in rows:
            identifier = failure(
                "task_recovered_after_interruption", RuntimeError(), level="warn", task_id=row["id"]
            )
            self._update_task(
                row["id"],
                {
                    "status": "FAILED",
                    "completed_at": now(),
                    "question": None,
                    "error": public_error(
                        identifier, "上次运行被中断，记录已保留，任务不会自动重跑"
                    ),
                },
            )
