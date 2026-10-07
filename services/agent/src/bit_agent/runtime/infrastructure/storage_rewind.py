"""每个对话只保留最新一轮开始前的上下文快照，用来“编辑并重发”或“重新生成”这一轮。

上下文在执行中可能被压缩改写，不能靠截断末尾恢复，所以在一轮开始前整份保存。
只保留最新一轮：图片等大内容不会随轮次成倍复制。
"""

import json
from typing import Any


class TurnCheckpoints:
    def _checkpoint_turn(self, session_id: str, task_id: str) -> None:
        current = self._db.execute(
            "SELECT task_id FROM turn_checkpoints WHERE session_id=?", (session_id,)
        ).fetchone()
        if current is not None and current["task_id"] == task_id:
            return
        self._migrate_session(session_id)
        context = self._db.execute(
            "SELECT data FROM context_state WHERE session_id=?", (session_id,)
        ).fetchone()
        memory = self._db.execute(
            "SELECT data FROM working_memory WHERE thread_id=?", (session_id,)
        ).fetchone()
        self._db.execute(
            "INSERT OR REPLACE INTO turn_checkpoints VALUES (?, ?, ?, ?)",
            (
                session_id,
                task_id,
                context["data"] if context else None,
                memory["data"] if memory else None,
            ),
        )

    def _rewindable_task(self, session_id: str) -> str | None:
        """最新一轮有开始前的快照时，返回它的任务编号。"""
        checkpoint = self._db.execute(
            "SELECT task_id FROM turn_checkpoints WHERE session_id=?", (session_id,)
        ).fetchone()
        latest = self._db.execute(
            "SELECT id FROM tasks WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        if checkpoint is None or latest is None or checkpoint["task_id"] != latest["id"]:
            return None
        return latest["id"]

    def _restore(self, table: str, key: str, session_id: str, data: str | None) -> None:
        if data is None:
            self._db.execute(f"DELETE FROM {table} WHERE {key}=?", (session_id,))
        else:
            self._db.execute(f"INSERT OR REPLACE INTO {table} VALUES (?, ?)", (session_id, data))

    def _rewind_turn(self, session_id: str, task_id: str) -> dict[str, Any]:
        """恢复到这一轮开始前，并删除这一轮的记录；返回原来的要求和图片。"""
        if self._rewindable_task(session_id) != task_id:
            raise ValueError("只能修改这个对话的最后一轮")
        checkpoint = self._db.execute(
            "SELECT context, memory FROM turn_checkpoints WHERE session_id=?", (session_id,)
        ).fetchone()
        task = json.loads(
            self._db.execute("SELECT data FROM tasks WHERE id=?", (task_id,)).fetchone()["data"]
        )
        self._restore("context_state", "session_id", session_id, checkpoint["context"])
        self._restore("working_memory", "thread_id", session_id, checkpoint["memory"])
        for table in ("events", "transcript", "user_answers"):
            self._db.execute(f"DELETE FROM {table} WHERE task_id=?", (task_id,))
        self._db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        self._db.execute("DELETE FROM turn_checkpoints WHERE session_id=?", (session_id,))
        # 唯一的一轮被收回时，对话本身也删除，侧栏不留空对话。
        remaining = self._db.execute(
            "SELECT 1 FROM tasks WHERE session_id=? LIMIT 1", (session_id,)
        ).fetchone()
        if remaining is None:
            self._delete_session(session_id)
        return {
            "objective": task["objective"],
            "images": task.get("images") or [],
            **({"attachments": task["attachments"]} if task.get("attachments") else {}),
            "workspace_root": task["workspace_root"],
            "session_deleted": remaining is None,
        }
